import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Model, Plugin, Provider } from "@opencode/plugin"
import type { ProviderRecord } from "@opencode/plugin/promise/provider"
import { fetchCatalog, price, type Entry } from "./models.ts"
import { keyFor, PinnedKeyKind, pinnedKeyCache } from "./profile.ts"

const providerID = "zeldoc"
// OpenCode 2 keeps a background service running across TUI restarts, so a
// restart no longer refreshes the list. Refresh on a timer instead.
const refreshInterval = 5 * 60_000
// OpenCode 2 gives plugins no logger and drops their console output (2.0.26),
// so a failed fetch is reported by this command instead of a log line.
const debugCommand = "zeldoc-debug"

type USD = Model.Info["cost"][number]["input"]
type KeyChoice = { apiKey?: string; source: string }

// OpenCode 2 entry point. Provider transforms must be synchronous, so the
// catalog is fetched here and captured for the transform to replay.
export async function setup(ctx: Plugin.Context) {
  let inventory: { apiKey: string; entries: Entry[]; at: Date } | undefined
  // The last fetch, for the debug report: when, with which key, and why it failed.
  let lastFetch: { apiKey: string; at: Date; error?: string } | undefined
  // The key a `.zeldoc-profile` file picks for this location's project, if any.
  const directory = ctx.location?.directory
  const pins = directory ? pinnedKeyCache(directory) : undefined

  // A pin wins over OpenCode's own key. A pin without a key lists nothing
  // from Zeldoc: OpenCode's own key may be another customer's.
  async function currentKey(): Promise<KeyChoice> {
    const pinned = pins ? await pins.current() : undefined
    if (pinned?.kind === PinnedKeyKind.Key) return { apiKey: pinned.key, source: `pinned by ${pinned.pin}` }
    if (pinned?.kind === PinnedKeyKind.Error) return { source: pinned.message }
    return activeKey(ctx)
  }

  // force: fetch even though the active key already has an inventory.
  async function load(force: boolean) {
    const { apiKey } = await currentKey()
    // Never show one key's models for another key.
    if (inventory?.apiKey !== apiKey) inventory = undefined
    if (!apiKey || (inventory && !force)) return
    const baseURL = await ctx.provider.get({ providerID }).then(
      (result) => result.data.settings?.baseURL,
      () => undefined,
    )
    const at = new Date()
    if (typeof baseURL !== "string") {
      lastFetch = { apiKey, at, error: "OpenCode has no base URL for the zeldoc provider." }
      return
    }
    // A failed fetch keeps the last inventory for this key, or the models.dev catalog when there is none.
    const entries = await fetchCatalog(baseURL, apiKey).catch((error: unknown) => {
      lastFetch = { apiKey, at, error: error instanceof Error ? error.message : String(error) }
      return undefined
    })
    if (!entries) return
    inventory = { apiKey, entries, at }
    lastFetch = { apiKey, at }
  }

  // Which key this location uses and where its models came from. Shows a
  // fingerprint, never the key: the report stays in the session for the model to read.
  async function report() {
    const { apiKey, source } = await currentKey()
    const version = (await packageVersion()) ?? "(unknown version)"
    const lines = [`opencode-zeldoc ${version}, OpenCode ${ctx.app.version}${directory ? `, in ${directory}` : ""}`]
    lines.push(
      apiKey
        ? `Key: ${fingerprint(apiKey)}, ${source}. The Zeldoc dashboard's Key column starts with these 8 characters for this key.`
        : `Key: none. ${source}`,
    )
    lines.push(
      inventory && inventory.apiKey === apiKey
        ? `Models: ${inventory.entries.length} from Zeldoc for this key, fetched ${inventory.at.toISOString()}: ${inventory.entries.map((entry) => entry.id).join(", ")}`
        : "Models: models.dev's Zeldoc models, not this key's.",
    )
    if (apiKey && lastFetch?.apiKey === apiKey && lastFetch.error)
      lines.push(`Last fetch failed, ${lastFetch.at.toISOString()}: ${lastFetch.error}`)
    return lines.join("\n")
  }

  let queue = Promise.resolve()
  const refresh = (force: boolean) => {
    queue = queue
      .then(() => load(force))
      .then(() => ctx.provider.reload())
      .catch(() => {})
    return queue
  }

  await load(true)
  const registrations: Array<{ dispose(): Promise<void> }> = [
    await ctx.provider.transform((editor) => {
      const record = editor.get(providerID)
      if (!record) return
      // Makes Zeldoc available in a pinned project without a stored login or
      // ZELDOC_API_KEY. With one, OpenCode sends the connection's key; the
      // http.request hook below replaces it.
      const pinnedKey = pins ? keyFor(pins.last) : undefined
      if (pinnedKey !== undefined)
        editor.update(providerID, (provider) => {
          provider.settings = { ...provider.settings, apiKey: pinnedKey }
          provider.activation = "enabled"
        })
      if (inventory) editor.models.set(providerID, toModels(inventory.entries, record))
    }),
  ]
  // Each Zeldoc request in a pinned project goes out with the pinned key, or
  // fails saying why there is none; never with OpenCode's own key.
  if (pins)
    registrations.push(
      await ctx.session.hook(
        "http.request",
        async (input) => {
          const pinned = await pins.current()
          if (pinned.kind === PinnedKeyKind.None) return
          if (pinned.kind === PinnedKeyKind.Error) throw new Error(pinned.message)
          const headers = new Headers(input.request.headers)
          headers.set("authorization", `Bearer ${pinned.key}`)
          input.request = new Request(input.request, { headers })
          // The pin now picks another key: list that key's models.
          if (inventory && inventory.apiKey !== pinned.key) void refresh(false)
        },
        { providerID },
      ),
    )
  // `/zeldoc-debug` refreshes the list, so the report says what happens now.
  // resume: false adds the report to the session without starting a model turn.
  // A command that fails to register must not cost the user the model list.
  const debug = await ctx.command
    .transform((editor) =>
      editor.add({
        name: debugCommand,
        description: "Show which Zeldoc key and models OpenCode uses, after refreshing the list",
        async execute(input) {
          await refresh(true)
          const text = await report()
          await ctx.session.synthetic({ sessionID: input.sessionID, description: `/${debugCommand}`, text, resume: false })
        },
      }),
    )
    .catch(() => undefined)
  if (debug) registrations.push(debug)

  const controller = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (
        event.type === "credential.updated" ||
        (event.type === "credential.switched" && event.data.integrationID === providerID)
      )
        void refresh(false)
    }
  })().catch(() => {})
  const timer = setInterval(() => void refresh(true), refreshInterval)

  return async () => {
    clearInterval(timer)
    controller.abort()
    await Promise.all(registrations.map((registration) => registration.dispose()))
  }
}

// A stored key wins over ZELDOC_API_KEY; OpenCode resolves both as connections.
async function activeKey(ctx: Plugin.Context): Promise<KeyChoice> {
  const connection = await ctx.integration.connection.active(providerID)
  const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
  if (!connection) return { source: "OpenCode has no Zeldoc login, and ZELDOC_API_KEY is not set." }
  if (credential?.type !== "key") return { source: "OpenCode's Zeldoc login has no API key." }
  const source =
    connection.type === "env"
      ? `from the ${connection.name} environment variable`
      : `from OpenCode's Zeldoc login${connection.label ? ` "${connection.label}"` : ""}`
  return { apiKey: credential.key, source }
}

// The start of the key's SHA-256: the gateway stores keys as that hash, and
// the dashboard's Key column shows its first 8 characters.
function fingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8)
}

// Read when asked rather than imported: the entry module stays free of side effects.
async function packageVersion() {
  try {
    const manifest: { version?: unknown } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    return typeof manifest.version === "string" ? manifest.version : undefined
  } catch {
    return undefined
  }
}

export function toModels(entries: readonly Entry[], record: ProviderRecord) {
  return entries.map((entry) => toModel(entry, record.provider, record.models.get(entry.id)))
}

// The endpoint is the source of truth for limits, prices and capabilities;
// models.dev still supplies what it cannot know (display name, family,
// reasoning field format, request settings).
function toModel(entry: Entry, provider: Provider.Info, template: Model.Info | undefined): Model.Info {
  const capabilities = entry.capabilities
  const cost = template?.cost.find((tier) => tier.tier === undefined)
  return {
    id: entry.id as Model.ID,
    modelID: entry.id as Model.ID,
    providerID: provider.id,
    canonical: template?.canonical,
    family: template?.family,
    name: template?.name ?? entry.id,
    compatibility: template?.compatibility,
    package: template?.package,
    // models.dev gives OpenAI-compatible models this setting, which names the provider in requests.
    settings: template?.settings ?? { provider: provider.id },
    headers: template?.headers,
    body: template?.body,
    capabilities: {
      tools: capabilities.tool_calls,
      input: [
        "text",
        ...(capabilities.vision ? ["image"] : []),
        ...(capabilities.pdf_input ? ["pdf"] : []),
        ...(template?.capabilities.input.filter((kind) => kind === "audio" || kind === "video") ?? []),
      ],
      output: template?.capabilities.output ?? ["text"],
    },
    variants:
      capabilities.reasoning_efforts.length > 0
        ? capabilities.reasoning_efforts.map((effort) => ({
            id: effort as Model.VariantID,
            settings: { reasoningEffort: effort },
          }))
        : (template?.variants ?? []),
    time: { released: template?.time.released ?? 0 },
    cost: [
      {
        input: usd(entry.pricing.input, cost?.input),
        output: usd(entry.pricing.output, cost?.output),
        cache: {
          read: usd(entry.pricing.cache_read, cost?.cache.read),
          write: usd(entry.pricing.cache_write, cost?.cache.write),
        },
      },
    ],
    status: template?.status ?? "active",
    enabled: template?.enabled ?? true,
    limit: {
      context: entry.limits.context ?? template?.limit.context ?? 0,
      input: template?.limit.input,
      output: entry.limits.output ?? template?.limit.output ?? 0,
    },
  }
}

function usd(value: string | null, fallback: number | undefined) {
  return price(value, fallback) as USD
}
