import type { Model, Plugin, Provider } from "@opencode/plugin"
import type { ProviderRecord } from "@opencode/plugin/promise/provider"
import { fetchCatalog, price, type Entry } from "./models.ts"
import { keyFor, PinnedKeyKind, pinnedKeyCache } from "./profile.ts"

const providerID = "zeldoc"
// OpenCode 2 keeps a background service running across TUI restarts, so a
// restart no longer refreshes the list. Refresh on a timer instead.
const refreshInterval = 5 * 60_000

type USD = Model.Info["cost"][number]["input"]

// OpenCode 2 entry point. Provider transforms must be synchronous, so the
// catalog is fetched here and captured for the transform to replay.
export async function setup(ctx: Plugin.Context) {
  let inventory: { apiKey: string; entries: Entry[] } | undefined
  // The key a `.zeldoc-profile` file picks for this location's project, if any.
  const directory = ctx.location?.directory
  const pins = directory ? pinnedKeyCache(directory) : undefined

  // A pin wins over OpenCode's own key. A pin without a key lists nothing
  // from Zeldoc: OpenCode's own key may be another customer's.
  async function currentKey() {
    const pinned = pins ? await pins.current() : undefined
    if (pinned?.kind === PinnedKeyKind.Key) return pinned.key
    if (pinned?.kind === PinnedKeyKind.Error) return undefined
    return activeKey(ctx)
  }

  // force: fetch even though the active key already has an inventory.
  async function load(force: boolean) {
    const apiKey = await currentKey()
    // Never show one key's models for another key.
    if (inventory?.apiKey !== apiKey) inventory = undefined
    if (!apiKey || (inventory && !force)) return
    const baseURL = await ctx.provider.get({ providerID }).then(
      (result) => result.data.settings?.baseURL,
      () => undefined,
    )
    if (typeof baseURL !== "string") return
    // A failed fetch keeps the last inventory for this key, or the models.dev catalog when there is none.
    const entries = await fetchCatalog(baseURL, apiKey).catch(() => undefined)
    if (entries) inventory = { apiKey, entries }
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
async function activeKey(ctx: Plugin.Context) {
  const connection = await ctx.integration.connection.active(providerID)
  const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
  return credential?.type === "key" ? credential.key : undefined
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
