import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// A `.zeldoc-profile` file pins a project to one of the API keys saved by the
// zeldoc CLI (`zeldoc auth pin <profile>`). Without one, nothing here runs and
// the plugin uses OpenCode's own Zeldoc key, as before.
export const pinFileName = ".zeldoc-profile"

const cliTimeout = 5_000
const cliInstallURL = "https://github.com/martinmose/zeldoc-cli#install"

// What a pin gave. A const object rather than an `enum`: the package ships
// TypeScript source, and Node's type stripping cannot run enums.
export const PinnedKeyKind = {
  // No pin file: OpenCode's own key is used.
  None: "none",
  // The key the pinned profile has.
  Key: "key",
  // A pin, but no key for it, and why. A pinned project never falls back to
  // OpenCode's own key: that key may belong to another customer.
  Error: "error",
} as const

export type PinnedKey =
  | { kind: typeof PinnedKeyKind.None }
  | { kind: typeof PinnedKeyKind.Key; key: string; pin: string }
  | { kind: typeof PinnedKeyKind.Error; message: string; pin: string }

const noPin: PinnedKey = { kind: PinnedKeyKind.None }

// The pin file for `directory`, the nearest one at or above it, with its
// contents so a changed pin can be noticed.
export async function findPin(directory: string) {
  for (let folder = directory; ; folder = dirname(folder)) {
    const path = join(folder, pinFileName)
    const contents = await readPin(path)
    if (contents !== undefined) return { path, contents }
    if (dirname(folder) === folder) return undefined
  }
}

async function readPin(path: string) {
  try {
    if (!(await stat(path)).isFile()) return undefined
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

// The key for `directory`. The CLI picks it (`zeldoc auth token` run in the
// directory), so the plugin follows exactly the rules the CLI follows.
// `commands` is where to look for the CLI, first match wins.
export async function resolvePinnedKey(directory: string, commands = cliCommands()): Promise<PinnedKey> {
  const pin = await findPin(directory)
  if (!pin) return noPin

  let lastError: unknown
  for (const command of commands) {
    try {
      const key = (await run(command, ["auth", "token"], directory)).trim()
      if (key) return { kind: PinnedKeyKind.Key, key, pin: pin.path }
      lastError = new Error("the zeldoc CLI printed no key")
      break
    } catch (error) {
      lastError = error
      // Not installed at this place: try the next one.
      if (isNotFound(error)) continue
      break
    }
  }
  return { kind: PinnedKeyKind.Error, pin: pin.path, message: describe(pin.path, lastError) }
}

// The PATH first; then where the CLI's installers put it, because OpenCode
// started from a desktop launcher may not have that folder on its PATH.
function cliCommands() {
  const binary = process.platform === "win32" ? "zeldoc.exe" : "zeldoc"
  const installFolder = process.env.XDG_BIN_HOME || join(homedir(), ".local", "bin")
  return ["zeldoc", join(installFolder, binary)]
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(command, args, { cwd, timeout: cliTimeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }))
      else resolve(String(stdout))
    })
  })
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
}

function describe(pin: string, error: unknown) {
  if (isNotFound(error))
    return `Zeldoc: ${pin} pins this project to a saved API key, but the zeldoc CLI is not installed. Install it: ${cliInstallURL}`
  const stderr = typeof error === "object" && error !== null ? (error as { stderr?: unknown }).stderr : undefined
  // The CLI's own message already names the pin file and says what to do.
  const reason =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim().replace(/^error:\s*/, "")
      : `${pin} pins this project to a saved API key, but ${error instanceof Error ? error.message : String(error)}`
  return `Zeldoc: ${reason}`
}

// Re-reads the pinned key when the pin file changes, at most every
// `retryAfter` ms after a failure (so `zeldoc auth login` takes effect without
// a restart), and every `maxAge` ms otherwise (a key replaced under the same
// profile).
export function pinnedKeyCache(directory: string, options: { commands?: string[]; retryAfter?: number; maxAge?: number } = {}) {
  const retryAfter = options.retryAfter ?? 10_000
  const maxAge = options.maxAge ?? 5 * 60_000
  let state: { value: PinnedKey; pinContents: string | undefined; at: number } | undefined
  let pending: Promise<PinnedKey> | undefined

  async function refresh() {
    const pin = await findPin(directory)
    const value = await resolvePinnedKey(directory, options.commands)
    state = { value, pinContents: pin?.contents, at: Date.now() }
    return value
  }

  return {
    // The last value, without waiting; for hooks that must be synchronous.
    get last(): PinnedKey {
      return state?.value ?? noPin
    },
    async current(): Promise<PinnedKey> {
      if (state) {
        const pin = await findPin(directory)
        const age = Date.now() - state.at
        const stale =
          pin?.contents !== state.pinContents ||
          age > maxAge ||
          (state.value.kind === PinnedKeyKind.Error && age > retryAfter)
        if (!stale) return state.value
      }
      pending ??= refresh().finally(() => {
        pending = undefined
      })
      return pending
    },
  }
}

// Sent instead of OpenCode's own key when a pin has no key, so a request that
// gets past the error still cannot be billed to another customer's key.
export const blockedKey = "zeldoc-pinned-profile-has-no-key"

// The key to send for a pinned project, or undefined to keep OpenCode's own.
export function keyFor(pinned: PinnedKey) {
  if (pinned.kind === PinnedKeyKind.Key) return pinned.key
  if (pinned.kind === PinnedKeyKind.Error) return blockedKey
  return undefined
}
