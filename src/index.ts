import type { PluginModule } from "@opencode-ai/plugin"
import { discover } from "./models.ts"

const plugin: PluginModule = {
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
}

export default plugin
