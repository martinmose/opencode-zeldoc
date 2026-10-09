import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { Model, Plugin } from "@opencode/plugin"
import type { CommandDefinition, CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import plugin from "../src/index.ts"

function catalogModel(id: string, name: string) {
  return {
    id,
    modelID: id,
    providerID: "zeldoc",
    family: "claude",
    name,
    compatibility: { reasoningField: "reasoning_content" },
    settings: { provider: "zeldoc" },
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    time: { released: 1_767_225_600_000 },
    cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 200_000, output: 64_000 },
  } as unknown as Model.Info
}

function makeRecord(baseURL: string) {
  return {
    provider: {
      id: "zeldoc",
      name: "Zeldoc",
      activation: "auto",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL },
    },
    models: new Map([
      ["anthropic/claude-opus-5", catalogModel("anthropic/claude-opus-5", "Claude Opus 5")],
      ["anthropic/claude-opus-5.5", catalogModel("anthropic/claude-opus-5.5", "Claude Opus 5.5")],
    ]),
  } as unknown as ProviderRecord
}

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    mode: "chat",
    limits: { context: 1_000_000, output: 128_000 },
    pricing: { input: "4", output: "20", cache_read: "0.2", cache_write: "5" },
    capabilities: {
      tool_calls: true,
      reasoning: true,
      vision: true,
      pdf_input: true,
      prompt_caching: true,
      reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    ...overrides,
  }
}

// The part of the OpenCode 2 plugin context the plugin uses. The key is read on
// every call, so a test can switch it and announce that with emit().
function makeHost(record: ProviderRecord, key: { current: string | undefined }) {
  const transforms: Array<(editor: ProviderEditor) => void> = []
  const commands: CommandDefinition[] = []
  const pending: unknown[] = []
  let wake: (() => void) | undefined
  const host = { reloads: 0, synthetic: [] as Array<{ sessionID: string; text: string; resume?: boolean }> }

  const context = {
    app: { name: "opencode", version: "2.0.26", channel: "latest" },
    command: {
      async transform(callback: (editor: CommandEditor) => void) {
        callback({ add: (definition) => commands.push(definition) })
        return { async dispose() {} }
      },
    },
    session: {
      async synthetic(input: { sessionID: string; text: string; resume?: boolean }) {
        host.synthetic.push(input)
        return {}
      },
    },
    integration: {
      connection: {
        async active() {
          return key.current ? { type: "env", name: "ZELDOC_API_KEY" } : undefined
        },
        async resolve() {
          return key.current ? { type: "key", key: key.current } : undefined
        },
      },
    },
    provider: {
      async get() {
        return { data: record.provider }
      },
      async transform(callback: (editor: ProviderEditor) => void) {
        transforms.push(callback)
        return { async dispose() {} }
      },
      async reload() {
        host.reloads++
      },
    },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const event = pending.shift()
          if (event) {
            yield event
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }
      },
    },
  } as unknown as Plugin.Context

  return Object.assign(host, {
    context,
    emit(event: unknown) {
      pending.push(event)
      wake?.()
    },
    // Runs a plugin command as the user typing `/name` in a session would.
    async run(name: string) {
      const command = commands.find((definition) => definition.name === name)
      if (!command) throw new Error(`no command ${name}`)
      await command.execute({ sessionID: "ses_test" } as unknown as CommandInvocation)
    },
    // Replays the registered transforms like OpenCode does. undefined means
    // the plugin left the models.dev catalog as it was.
    models() {
      let result: readonly Model.Info[] | undefined
      const editor = {
        get: (providerID: string) => (providerID === "zeldoc" ? record : undefined),
        models: {
          set(_providerID: string, models: readonly Model.Info[]) {
            result = models
          },
        },
      } as unknown as ProviderEditor
      transforms.forEach((transform) => transform(editor))
      return result
    },
  })
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await Bun.sleep(10)
  expect(condition()).toBe(true)
}

test("shows only the chat models the API key can access, with catalog metadata", async () => {
  const requests: Array<{ authorization: string | null; path: string }> = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({ authorization: request.headers.get("authorization"), path: new URL(request.url).pathname })
      return Response.json({
        data: [
          entry("anthropic/claude-opus-5.5"),
          entry("zdev", {
            limits: { context: 1_000_000, output: 16_384 },
            pricing: { input: "0", output: "0", cache_read: "0", cache_write: null },
            capabilities: {
              tool_calls: true,
              reasoning: true,
              vision: true,
              pdf_input: false,
              prompt_caching: false,
              reasoning_efforts: [],
            },
          }),
          entry("zeldoc/embedding", { mode: "embedding" }),
          entry("jev-latest", { mode: null }),
        ],
      })
    },
  })
  const host = makeHost(makeRecord(`${server.url}v1`), { current: "test-token" })

  const cleanup = await plugin.setup(host.context)
  const models = host.models() ?? []
  await cleanup?.()

  expect(requests).toEqual([{ authorization: "Bearer test-token", path: "/v1/zeldoc/models" }])
  // Opus 5 is on models.dev but not on the key: hidden. Non-chat models too.
  expect<unknown>(models.map((model) => model.id)).toEqual(["anthropic/claude-opus-5.5", "zdev"])

  const [opus, zdev] = models
  expect(opus.name).toBe("Claude Opus 5.5")
  expect<unknown>(opus.family).toBe("claude")
  expect(opus.compatibility).toEqual({ reasoningField: "reasoning_content" })
  expect<unknown>(opus.cost).toEqual([{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }])
  expect(opus.limit).toEqual({ context: 1_000_000, input: undefined, output: 128_000 })
  expect<unknown>(opus.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(opus.variants[3].settings).toEqual({ reasoningEffort: "xhigh" })

  expect(zdev.name).toBe("zdev")
  expect<unknown>(zdev.modelID).toBe("zdev")
  expect<unknown>(zdev.providerID).toBe("zeldoc")
  expect(zdev.settings).toEqual({ provider: "zeldoc" })
  expect(zdev.limit).toEqual({ context: 1_000_000, input: undefined, output: 16_384 })
  expect<unknown>(zdev.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  expect(zdev.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
  expect(zdev.variants).toEqual([])
})

test("keeps the models.dev catalog when discovery fails", async () => {
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, { status: 503 })
    },
  })
  const host = makeHost(makeRecord(`${server.url}v1`), { current: "test-token" })

  const cleanup = await plugin.setup(host.context)
  await cleanup?.()

  expect(host.models()).toBeUndefined()
})

test("leaves the catalog alone without a Zeldoc key", async () => {
  let requests = 0
  using server = Bun.serve({
    port: 0,
    fetch() {
      requests++
      return Response.json({ data: [entry("zdev")] })
    },
  })
  const host = makeHost(makeRecord(`${server.url}v1`), { current: undefined })

  const cleanup = await plugin.setup(host.context)
  await cleanup?.()

  expect(requests).toBe(0)
  expect(host.models()).toBeUndefined()
})

test("drops the previous key's models when the key changes", async () => {
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "Bearer first-key") return new Response(null, { status: 401 })
      return Response.json({ data: [entry("anthropic/claude-opus-5.5")] })
    },
  })
  const key = { current: "first-key" as string | undefined }
  const host = makeHost(makeRecord(`${server.url}v1`), key)

  const cleanup = await plugin.setup(host.context)
  expect<unknown>(host.models()?.map((model) => model.id)).toEqual(["anthropic/claude-opus-5.5"])

  // The second key cannot list models, so the catalog must come back rather than the first key's list.
  key.current = "second-key"
  host.emit({ type: "credential.switched", data: { integrationID: "zeldoc", credentialID: null } })
  await until(() => host.reloads === 1)
  await cleanup?.()

  expect(host.models()).toBeUndefined()
})

test("/zeldoc-debug says why the list is models.dev's, without showing the key", async () => {
  // A sandbox proxy that adds the real key to chat requests only: the catalog sees its placeholder.
  using server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: "Missing API key" }, { status: 401 })
    },
  })
  const host = makeHost(makeRecord(`${server.url}v1`), { current: "proxy-managed" })

  const cleanup = await plugin.setup(host.context)
  await host.run("zeldoc-debug")
  await cleanup?.()

  expect(host.synthetic).toHaveLength(1)
  const [report] = host.synthetic
  expect(report.sessionID).toBe("ses_test")
  expect(report.resume).toBe(false)
  const fingerprint = createHash("sha256").update("proxy-managed").digest("hex").slice(0, 8)
  expect(report.text).toContain(`Key: ${fingerprint}, from the ZELDOC_API_KEY environment variable.`)
  expect(report.text).toContain("Models: models.dev's Zeldoc models, not this key's.")
  expect(report.text).toContain(`GET ${server.url}v1/zeldoc/models answered 401: Missing API key`)
  expect(report.text).not.toContain("proxy-managed")
})

test("/zeldoc-debug refreshes the list before reporting it", async () => {
  let answers = 0
  using server = Bun.serve({
    port: 0,
    fetch() {
      // Fails when OpenCode starts, works by the time the user asks.
      if (answers++ === 0) return new Response(null, { status: 503 })
      return Response.json({ data: [entry("zdev"), entry("anthropic/claude-opus-5.5")] })
    },
  })
  const host = makeHost(makeRecord(`${server.url}v1`), { current: "test-token" })

  const cleanup = await plugin.setup(host.context)
  expect(host.models()).toBeUndefined()
  await host.run("zeldoc-debug")
  await cleanup?.()

  expect<unknown>(host.models()?.map((model) => model.id)).toEqual(["zdev", "anthropic/claude-opus-5.5"])
  const [report] = host.synthetic
  expect(report.text).toContain("Models: 2 from Zeldoc for this key")
  expect(report.text).toContain(": zdev, anthropic/claude-opus-5.5")
  expect(report.text).not.toContain("Last fetch failed")
})
