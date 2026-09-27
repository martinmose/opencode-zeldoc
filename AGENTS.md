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
- `src/v2.ts`: the OpenCode 2 `setup()` and its model mapping. Delete the
  OpenCode 1 parts once OpenCode 1 support ends.
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
- **Never show one key's models for another key.** On OpenCode 2 the list is
  dropped as soon as the active key changes, before the new key's list arrives.
- **Prices** arrive as decimal strings in USD per 1M tokens, which is the unit
  OpenCode's `cost` uses.

## Conventions

- **No short variable names.** Use `response` not `res`, `error` not `e`.
- **No mocks.** Test against a local HTTP server instead.

## Before committing

1. `bun test`: all tests pass
2. `bun run typecheck`: no type errors
3. `node_modules/` is gitignored; don't commit it
