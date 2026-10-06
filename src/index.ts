import type { PluginModule } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode/plugin"
import { server } from "./v1.ts"
import { setup } from "./v2.ts"

// OpenCode 1 (1.18.29 and newer) calls server(); OpenCode 2 calls setup().
// Each ignores the other's entry point.
const plugin: PluginModule & Plugin.Plugin = {
  id: "zeldoc",
  server,
  setup,
}

export default plugin
