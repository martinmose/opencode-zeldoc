import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import type { Model, Provider } from "@opencode-ai/sdk/v2"
import plugin from "../src/index.ts"

function catalogModel(id: string, name: string, baseURL: string): Model {
  return {
    id,
    providerID: "zeldoc",
    name,
    family: "claude",
    api: { id, url: baseURL, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 5, output: 25, cache: { read: 0.5, write: 0 } },
    limit: { context: 200_000, output: 64_000 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" },
    },
    release_date: "2026-01-01",
    variants: { high: { reasoningEffort: "high" } },
  }
}

function makeProvider(baseURL: string): Provider {
  return {
    id: "zeldoc",
    name: "Zeldoc",
    source: "api",
    env: ["ZELDOC_API_KEY"],
    options: {},
    models: {
      "anthropic/claude-opus-5": catalogModel("anthropic/claude-opus-5", "Claude Opus 5", baseURL),
      "anthropic/claude-opus-5.5": catalogModel("anthropic/claude-opus-5.5", "Claude Opus 5.5", baseURL),
    },
  }
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

async function models(provider: Provider) {
  const hooks = await plugin.server({} as never)
  return hooks.provider!.models!(provider, { auth: { type: "api", key: "test-token" } })
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
  const provider = makeProvider(`${server.url}v1`)

  const result = await models(provider)

  expect(requests).toEqual([{ authorization: "Bearer test-token", path: "/v1/zeldoc/models" }])
  // Opus 5 is on models.dev but not on the key: hidden. Non-chat models too.
  expect(Object.keys(result)).toEqual(["anthropic/claude-opus-5.5", "zdev"])

  const opus = result["anthropic/claude-opus-5.5"]
  expect(opus.name).toBe("Claude Opus 5.5")
  expect(opus.cost).toEqual({ input: 4, output: 20, cache: { read: 0.2, write: 5 } })
  expect(opus.limit).toEqual({ context: 1_000_000, output: 128_000 })
  expect(Object.keys(opus.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(opus.capabilities.interleaved).toEqual({ field: "reasoning_content" })

  const zdev = result.zdev
  expect(zdev.name).toBe("zdev")
  expect(zdev.api).toEqual({ id: "zdev", url: `${server.url}v1`, npm: "@ai-sdk/openai-compatible" })
  expect(zdev.limit).toEqual({ context: 1_000_000, output: 16_384 })
  expect(zdev.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  expect(zdev.capabilities.toolcall).toBe(true)
  expect(zdev.capabilities.reasoning).toBe(true)
  expect(zdev.capabilities.attachment).toBe(true)
  expect(zdev.capabilities.input.image).toBe(true)
  expect(zdev.capabilities.input.pdf).toBe(false)
  expect(zdev.variants).toBeUndefined()
})

test("keeps the models.dev catalog when discovery fails", async () => {
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, { status: 503 })
    },
  })
  const provider = makeProvider(`${server.url}v1`)

  expect(await models(provider)).toEqual(provider.models)
})

test("logs why discovery failed to OpenCode's log, without the key", async () => {
  const logs: unknown[] = []
  // One local server plays both Zeldoc and OpenCode's own server, which plugins log through.
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/log") {
        logs.push(await request.json())
        return Response.json(true)
      }
      return Response.json({ error: { message: "No access for test-token" } }, { status: 403 })
    },
  })
  const provider = makeProvider(`${server.url}v1`)
  const client = createOpencodeClient({ baseUrl: server.url.href })
  const hooks = await plugin.server({ client } as never)

  const result = await hooks.provider!.models!(provider, { auth: { type: "api", key: "test-token" } })
  for (let attempt = 0; attempt < 100 && logs.length === 0; attempt++) await Bun.sleep(10)

  expect(result).toEqual(provider.models)
  expect(logs).toEqual([
    {
      service: "opencode-zeldoc",
      level: "warn",
      message: `Showing models.dev's Zeldoc models: GET ${server.url}v1/zeldoc/models answered 403: No access for [API key]`,
    },
  ])
})
