import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import plugin from "../src/index.ts"
import { blockedKey, pinFileName, PinnedKeyKind, pinnedKeyCache, resolvePinnedKey } from "../src/profile.ts"

// A stand-in for the zeldoc CLI on PATH: `zeldoc auth token` prints the key of
// the profile named by the .zeldoc-profile file in the folder it runs in, like
// the real CLI, for the profiles "acme" and "globex"; any other profile is not
// saved.
const cli = `#!/bin/sh
profile=$(grep -v '^#' ${pinFileName} | head -n 1)
case "$profile" in
  acme) echo sk-acme ;;
  globex) echo sk-globex ;;
  *) echo "error: no API key is saved as profile \\\`$profile\\\`" >&2; exit 1 ;;
esac
`

let root: string
const originalPath = process.env.PATH

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-zeldoc-"))
  await mkdir(join(root, "bin"))
  await writeFile(join(root, "bin", "zeldoc"), cli)
  await chmod(join(root, "bin", "zeldoc"), 0o755)
  process.env.PATH = `${join(root, "bin")}${delimiter}${originalPath}`
})

afterAll(async () => {
  process.env.PATH = originalPath
  await rm(root, { recursive: true, force: true })
})

async function project(name: string, pin?: string) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  if (pin !== undefined) await writeFile(join(directory, pinFileName), `${pin}\n`)
  return directory
}

test("without a pin nothing is resolved and the CLI is not needed", async () => {
  const directory = await project("unpinned")
  expect(await resolvePinnedKey(directory, ["/nonexistent/zeldoc"])).toEqual({ kind: PinnedKeyKind.None })
})

test("a pin resolves to the key the CLI prints for the project", async () => {
  const directory = await project("acme-app", "acme")
  expect(await resolvePinnedKey(directory)).toEqual({
    kind: PinnedKeyKind.Key,
    key: "sk-acme",
    pin: join(directory, pinFileName),
  })
})

test("a pin without a saved key says why, in the CLI's words", async () => {
  const directory = await project("initech-app", "initech")
  const pinned = await resolvePinnedKey(directory)
  expect(pinned.kind).toBe(PinnedKeyKind.Error)
  expect(pinned.kind === PinnedKeyKind.Error && pinned.message).toContain("no API key is saved as profile `initech`")
})

test("a pin without the CLI says to install it", async () => {
  const directory = await project("acme-no-cli", "acme")
  const pinned = await resolvePinnedKey(directory, ["/nonexistent/zeldoc"])
  expect(pinned.kind === PinnedKeyKind.Error && pinned.message).toContain("the zeldoc CLI is not installed")
})

test("the cache follows a changed pin", async () => {
  const directory = await project("switching-app", "acme")
  const cache = pinnedKeyCache(directory)
  expect(await cache.current()).toMatchObject({ kind: PinnedKeyKind.Key, key: "sk-acme" })
  await writeFile(join(directory, pinFileName), "globex\n")
  expect(await cache.current()).toMatchObject({ kind: PinnedKeyKind.Key, key: "sk-globex" })
})

// OpenCode 1

test("OpenCode 1: a pinned project sends and lists with the pinned key", async () => {
  const requests: Array<string | null> = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.headers.get("authorization"))
      return Response.json({ data: [] })
    },
  })
  const directory = await project("acme-v1", "acme")
  const hooks = await plugin.server({ directory } as never)

  const config: { provider?: Record<string, { options?: Record<string, unknown> }> } = {
    provider: { zeldoc: { options: { timeout: 1 } } },
  }
  await hooks.config!(config as never)
  expect(config.provider?.zeldoc.options).toEqual({ timeout: 1, apiKey: "sk-acme" })

  const provider = { models: { zdev: { api: { url: `${server.url}v1` } } } }
  await hooks.provider!.models!(provider as never, { auth: { type: "api", key: "sk-opencode" } })
  expect(requests).toEqual(["Bearer sk-acme"])
})

test("OpenCode 1: a pin without a key never uses OpenCode's own key", async () => {
  const directory = await project("initech-v1", "initech")
  const hooks = await plugin.server({ directory } as never)

  const config: { provider?: Record<string, { options?: Record<string, unknown> }> } = {}
  await hooks.config!(config as never)
  expect(config.provider?.zeldoc.options?.apiKey).toBe(blockedKey)
  // What OpenCode 1.18 passes, which differs from its published types.
  const request = { model: { providerID: "zeldoc" }, provider: { id: "zeldoc" } }
  await expect(hooks["chat.headers"]!(request as never, { headers: {} })).rejects.toThrow("initech")
})

test("OpenCode 1: an unpinned project keeps OpenCode's config", async () => {
  const directory = await project("unpinned-v1")
  const hooks = await plugin.server({ directory } as never)
  const config = {}
  await hooks.config!(config as never)
  expect(config).toEqual({})
})

// OpenCode 2

// The parts of the OpenCode 2 context a pinned project uses, with no Zeldoc
// connection: the pin alone must make Zeldoc usable.
function makeHost(directory: string) {
  const transforms: Array<(editor: ProviderEditor) => void> = []
  const httpHooks: Array<(input: { request: Request }) => Promise<void> | void> = []
  const context = {
    location: { directory },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    provider: {
      get: async () => ({ data: { id: "zeldoc", settings: {} } }),
      async transform(callback: (editor: ProviderEditor) => void) {
        transforms.push(callback)
        return { async dispose() {} }
      },
      async reload() {},
    },
    session: {
      async hook(name: string, callback: (input: { request: Request }) => Promise<void>) {
        if (name === "http.request") httpHooks.push(callback)
        return { async dispose() {} }
      },
    },
    command: { transform: async () => ({ async dispose() {} }) },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    },
  } as unknown as Plugin.Context

  return {
    context,
    // Replays the transforms; returns the provider as they left it.
    provider() {
      const provider: { settings: Record<string, unknown>; activation: string } = { settings: {}, activation: "auto" }
      const editor = {
        get: () => ({ provider, models: new Map() }),
        update: (_id: string, update: (value: typeof provider) => void) => update(provider),
        models: { set() {} },
      } as unknown as ProviderEditor
      transforms.forEach((transform) => transform(editor))
      return provider
    },
    // Runs the http.request hooks on a request sent with OpenCode's own key.
    async send() {
      const request = new Request("https://api.zeldoc.ai/v1/chat/completions", {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer sk-opencode", "content-type": "application/json" },
      })
      const input = { request }
      for (const hook of httpHooks) await hook(input)
      return input.request
    },
  }
}

test("OpenCode 2: a pinned project's requests carry the pinned key", async () => {
  const host = makeHost(await project("acme-v2", "acme"))
  const cleanup = await plugin.setup(host.context)

  const request = await host.send()
  expect(request.headers.get("authorization")).toBe("Bearer sk-acme")
  expect(request.headers.get("content-type")).toBe("application/json")
  expect(await request.text()).toBe("{}")
  expect(host.provider()).toEqual({ settings: { apiKey: "sk-acme" }, activation: "enabled" })
  await cleanup?.()
})

test("OpenCode 2: a pin without a key fails the request instead of using OpenCode's key", async () => {
  const host = makeHost(await project("initech-v2", "initech"))
  const cleanup = await plugin.setup(host.context)

  await expect(host.send()).rejects.toThrow("no API key is saved as profile `initech`")
  expect(host.provider().settings.apiKey).toBe(blockedKey)
  await cleanup?.()
})

test("OpenCode 2: an unpinned project's requests are left alone", async () => {
  const host = makeHost(await project("unpinned-v2"))
  const cleanup = await plugin.setup(host.context)

  expect((await host.send()).headers.get("authorization")).toBe("Bearer sk-opencode")
  expect(host.provider()).toEqual({ settings: {}, activation: "auto" })
  await cleanup?.()
})
