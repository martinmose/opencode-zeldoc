# AGENTS.md

Guidance for AI agents (and humans) working on this repo.

## What this is

`opencode-zeldoc` is an [OpenCode](https://opencode.ai) plugin that replaces
the models.dev list of Zeldoc models with the models the user's API key can
actually call. It reads `GET {baseURL}/zeldoc/models`
(`https://api.zeldoc.ai/v1/zeldoc/models`), the public model catalog served by
the Zeldoc platform API.

One package supports both OpenCode 1 and OpenCode 2, which have separate plugin
APIs. OpenCode 1 (1.18.29 and newer) calls `server()` and uses its
`provider.models` hook for the `zeldoc` provider. OpenCode 2 calls `setup()`,
which replaces the provider's models through a provider transform.

## Dev environment

Uses [Flox](https://flox.dev) for reproducibility. Bun inside flox; the
`on-activate` hook runs `bun install`.

```bash
flox activate                    # enter dev env
bun test                         # run tests
bun run typecheck                # typecheck
```

Always run both `bun test` and `bun run typecheck` before considering work done.

## Code layout

- `src/index.ts`: the npm package entry point. Default-exports the plugin
  module (`{ id, server, setup }`) and nothing else. OpenCode's loader treats
  every named export of the entry module as a candidate plugin and rejects
  non-function exports, so keep this file export-clean.
- `src/models.ts`: fetching the catalog, and the OpenCode 1 model mapping. No
  import-time side effects.
- `src/v1.ts`: the OpenCode 1 `server()`: the model list, and a pinned
  project's key through the `config` hook.
- `src/profile.ts`: `.zeldoc-profile` pins. Finds the pin and asks the zeldoc
  CLI for the key (`zeldoc auth token` in the project folder), so the CLI's
  rules for picking a key are the only ones. `PinnedKeyKind` is a const object,
  not an `enum`: the package ships TypeScript source, and Node's type stripping
  cannot run enums.
- `src/v2.ts`: the OpenCode 2 `setup()`, its model mapping and the
  `/zeldoc-debug` command. Delete the OpenCode 1 parts once OpenCode 1 support
  ends.
- `test/profile.test.ts`: pins in both versions, with a stand-in `zeldoc`
  script on `PATH`.
- `test/models.test.ts` (OpenCode 1) and `test/v2.test.ts` (OpenCode 2): tests
  with `bun:test` against a local `Bun.serve` server that answers like the real
  endpoint. The OpenCode 2 tests pass `setup()` a small stand-in for the parts
  of the plugin context it uses.
- `@opencode-ai/plugin` (OpenCode 1) and `@opencode/plugin` (OpenCode 2) are
  imported for types only, so the published package has no runtime
  dependencies. Keep those imports `import type`.
- `opencode.jsonc`: local dev config that loads the plugin from source in
  OpenCode 1. End users install from npm instead: `"plugin": ["opencode-zeldoc"]`.
  OpenCode 2 needs a plugin directory instead; see the README.

## Behaviour to keep

- **Only chat models** (`mode === "chat"`) are returned; the catalog also lists
  embedding, transcription and image models the key may have.
- **The endpoint wins** for limits, prices and capabilities; models.dev only
  fills what the endpoint cannot know (display name, family, interleaved
  reasoning format).
- **Fall back to `provider.models`** (the models.dev list) on any failure.
  Returning `{}` would leave the user with no Zeldoc models at all. On
  OpenCode 2 a failed refresh keeps the last list fetched for the same key.
- **A fallback says why.** A failed fetch names the URL and what the endpoint
  answered. OpenCode 1 logs it with `client.app.log`. OpenCode 2 gives plugins
  no logger and drops their console output (checked in 2.0.26), so
  `/zeldoc-debug` reports it instead. Without this, a key that cannot reach the
  catalog looks exactly like a key with only ZDev.
- **Never show the key**, in a log line, an error or the debug report: the
  report stays in the session, where the model reads it. Show the first 8 hex
  characters of its SHA-256, which the dashboard's Key column shows too.
- **Never show one key's models for another key.** On OpenCode 2 the list is
  dropped as soon as the active key changes, before the new key's list arrives.
- **Without a pin, nothing changes**: no CLI call, OpenCode's own key.
- **A pinned project never uses OpenCode's own key.** It may be another
  customer's. Without a pinned key, requests fail saying why
  (`chat.headers` on OpenCode 1, `http.request` on OpenCode 2) and the
  provider's key is set to `blockedKey`.
- **OpenCode 1's `chat.headers` input** carries the provider's info as
  `provider`, not `provider.info` as its types say. Use `model.providerID`, as
  OpenCode's own plugins do (seen live in 1.18.34).
- **Prices** arrive as decimal strings in USD per 1M tokens, which is the unit
  OpenCode's `cost` uses.

## Conventions

- **No short variable names.** Use `response` not `res`, `error` not `e`.
- **No mocks.** Test against a local HTTP server instead.

## Before committing

1. `bun test`: all tests pass
2. `bun run typecheck`: no type errors
3. `node_modules/` is gitignored; don't commit it
