# AGENTS.md

Guidance for AI agents (and humans) working on this repo.

## What this is

`opencode-zeldoc` is an [OpenCode](https://opencode.ai) plugin that replaces
the models.dev list of Zeldoc models with the models the user's API key can
actually call. It uses the `provider.models` hook for the `zeldoc` provider and
reads `GET {baseURL}/zeldoc/models` (`https://api.zeldoc.ai/v1/zeldoc/models`),
the public model catalog served by the Zeldoc platform API.

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
  module (`{ id, server }`) and nothing else. OpenCode's loader treats every
  named export of the entry module as a candidate plugin and rejects
  non-function exports, so keep this file export-clean.
- `src/models.ts`: fetching and mapping the catalog. No import-time side
  effects.
- `test/models.test.ts`: tests with `bun:test` against a local `Bun.serve`
  server that answers like the real endpoint.
- `opencode.jsonc`: local dev config that loads the plugin from source. End
  users install from npm instead: `"plugin": ["opencode-zeldoc"]`.

## Behaviour to keep

- **Only chat models** (`mode === "chat"`) are returned; the catalog also lists
  embedding, transcription and image models the key may have.
- **The endpoint wins** for limits, prices and capabilities; models.dev only
  fills what the endpoint cannot know (display name, family, interleaved
  reasoning format).
- **Fall back to `provider.models`** (the models.dev list) on any failure.
  Returning `{}` would leave the user with no Zeldoc models at all.
- **Prices** arrive as decimal strings in USD per 1M tokens, which is the unit
  OpenCode's `cost` uses.

## Conventions

- **No short variable names.** Use `response` not `res`, `error` not `e`.
- **No mocks.** Test against a local HTTP server instead.

## Before committing

1. `bun test`: all tests pass
2. `bun run typecheck`: no type errors
3. `node_modules/` is gitignored; don't commit it
