import type { PluginModule } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { discover } from "./models.ts"
import { setup } from "./v2.ts"

// OpenCode 1 (1.18.29 and newer) calls server(); OpenCode 2 calls setup().
// Each ignores the other's entry point.
const plugin: PluginModule & Plugin.Plugin = {
  id: "zeldoc",
  server: async () => ({
    provider: {
      id: "zeldoc",
      async models(provider, ctx) {
        const apiKey = ctx.auth?.type === "api" ? ctx.auth.key : process.env.ZELDOC_API_KEY
        const baseURL = Object.values(provider.models)[0]?.api.url
        if (!apiKey || !baseURL) return provider.models

        // Keep the models.dev catalog when discovery fails instead of leaving the user with no models.
        return discover(baseURL, apiKey, provider.models).catch(() => provider.models)
      },
    },
  }),
  setup,
}

export default plugin
