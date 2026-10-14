import type { WebSearch } from "@opencode/plugin"

// One result of POST /v1/search/zeldoc-search. `date` is often empty.
type Hit = { title?: string; url?: string; snippet?: string; date?: string }

// OpenCode 2's websearch tool hands providers only the query, so time_range,
// language and engines are not sent.
export async function search(baseURL: string, apiKey: string, query: string, signal?: AbortSignal) {
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/search/zeldoc-search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  })
  if (!response.ok) throw new Error(`Zeldoc.ai search failed: HTTP ${response.status}`)
  const body = (await response.json()) as { results?: Hit[] }
  return (body.results ?? []).flatMap(toResult)
}

function toResult(hit: Hit): WebSearch.Result[] {
  if (!hit.url) return []
  const published = hit.date ? Date.parse(hit.date) : Number.NaN
  return [
    {
      url: hit.url,
      ...(hit.title ? { title: hit.title } : {}),
      ...(hit.snippet ? { content: hit.snippet } : {}),
      time: Number.isFinite(published) ? { published } : {},
    },
  ]
}
