import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { discover } from "./models.ts"
import { keyFor, PinnedKeyKind, resolvePinnedKey, type PinnedKey } from "./profile.ts"

const providerID = "zeldoc"

// OpenCode 1 entry point. OpenCode creates one plugin instance per project
// directory and reads its config once, so a pin is resolved here, once; a
// changed pin takes effect when OpenCode restarts.
export async function server(input: PluginInput): Promise<Hooks> {
  const pinned: PinnedKey = input?.directory
    ? await resolvePinnedKey(input.directory)
    : { kind: PinnedKeyKind.None }
  const pinnedKey = keyFor(pinned)

  return {
    // A key in the provider's options wins over the stored login and
    // ZELDOC_API_KEY, and makes Zeldoc available without either.
    async config(config) {
      if (pinnedKey === undefined) return
      const providers = (config.provider ??= {})
      const zeldoc = providers[providerID] ?? {}
      providers[providerID] = { ...zeldoc, options: { ...zeldoc.options, apiKey: pinnedKey } }
    },
    // Say why requests fail instead of letting Zeldoc answer 401. OpenCode
    // passes the provider's info as `provider`, not the `provider.info` its
    // types describe, so the model's providerID is used, as OpenCode's own
    // plugins do.
    async "chat.headers"(request) {
      if (pinned.kind === PinnedKeyKind.Error && request.model.providerID === providerID) throw new Error(pinned.message)
    },
    provider: {
      id: providerID,
      async models(provider, ctx) {
        // A pin without a key lists nothing from Zeldoc: OpenCode's own key may be another customer's.
        const ownKey = ctx.auth?.type === "api" ? ctx.auth.key : process.env.ZELDOC_API_KEY
        const apiKey =
          pinned.kind === PinnedKeyKind.None ? ownKey : pinned.kind === PinnedKeyKind.Key ? pinned.key : undefined
        const baseURL = Object.values(provider.models)[0]?.api.url
        if (!apiKey || !baseURL) return provider.models

        // Keep the models.dev catalog when discovery fails instead of leaving the user with no models.
        return discover(baseURL, apiKey, provider.models).catch((error: unknown) => {
          warn(input?.client, `Showing models.dev's Zeldoc models: ${error instanceof Error ? error.message : error}`)
          return provider.models
        })
      },
    },
  }
}

// Goes to OpenCode's log file. Not awaited: a log line must never hold up the model list.
function warn(client: PluginInput["client"] | undefined, message: string) {
  client?.app.log({ body: { service: "opencode-zeldoc", level: "warn", message } }).catch(() => {})
}
