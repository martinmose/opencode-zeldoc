import type { Model } from "@opencode-ai/sdk/v2"

// One entry of GET /v1/zeldoc/models (the Zeldoc platform API's public model
// catalog). Prices are decimal strings in USD per 1M tokens, already what the
// key's organization pays.
type Entry = {
  id: string
  mode: string | null
  limits: { context: number | null; output: number | null }
  pricing: { input: string | null; output: string | null; cache_read: string | null; cache_write: string | null }
  capabilities: {
    tool_calls: boolean
    reasoning: boolean
    vision: boolean
    pdf_input: boolean
    prompt_caching: boolean
    reasoning_efforts: string[]
  }
}

// Returns only the chat models the API key can access. Anything on models.dev
// that the key no longer has (e.g. a retired model) disappears from the picker.
export async function discover(baseURL: string, apiKey: string, catalog: Record<string, Model>) {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/zeldoc/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`Failed to fetch Zeldoc models: ${res.status}`)
  const entries = parse(await res.json())

  return Object.fromEntries(
    entries
      .filter((entry) => entry.mode === "chat")
      .map((entry) => [entry.id, toModel(entry, baseURL, catalog[entry.id])]),
  )
}

function parse(body: unknown): Entry[] {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Unexpected Zeldoc model catalog response")
  return body.data.filter((item): item is Entry => isRecord(item) && typeof item.id === "string")
}

// The endpoint is the source of truth for limits, prices and capabilities;
// models.dev still supplies what it cannot know (display name, family,
// interleaved reasoning format).
function toModel(entry: Entry, baseURL: string, template: Model | undefined): Model {
  const capabilities = entry.capabilities
  return {
    id: entry.id,
    providerID: "zeldoc",
    name: template?.name ?? entry.id,
    family: template?.family,
    api: {
      id: entry.id,
      url: baseURL,
      npm: template?.api.npm ?? "@ai-sdk/openai-compatible",
    },
    status: template?.status ?? "active",
    headers: { ...template?.headers },
    options: { ...template?.options },
    cost: {
      input: price(entry.pricing.input, template?.cost.input),
      output: price(entry.pricing.output, template?.cost.output),
      cache: {
        read: price(entry.pricing.cache_read, template?.cost.cache.read),
        write: price(entry.pricing.cache_write, template?.cost.cache.write),
      },
    },
    limit: {
      context: entry.limits.context ?? template?.limit.context ?? 0,
      input: template?.limit.input,
      output: entry.limits.output ?? template?.limit.output ?? 0,
    },
    capabilities: {
      temperature: template?.capabilities.temperature ?? true,
      reasoning: capabilities.reasoning,
      attachment: capabilities.vision || capabilities.pdf_input,
      toolcall: capabilities.tool_calls,
      input: {
        text: true,
        audio: template?.capabilities.input.audio ?? false,
        image: capabilities.vision,
        video: template?.capabilities.input.video ?? false,
        pdf: capabilities.pdf_input,
      },
      output: template?.capabilities.output ?? { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: template?.capabilities.interleaved ?? false,
    },
    release_date: template?.release_date ?? "",
    variants:
      capabilities.reasoning_efforts.length > 0
        ? Object.fromEntries(capabilities.reasoning_efforts.map((effort) => [effort, { reasoningEffort: effort }]))
        : template?.variants,
  }
}

function price(value: string | null, fallback: number | undefined) {
  if (value === null) return fallback ?? 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (fallback ?? 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
