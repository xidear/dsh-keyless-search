/**
 * Parallel's public search endpoint as a keyless backend.
 *
 * The endpoint speaks MCP; `web_search` takes a natural-language `objective`
 * plus an array of short `search_queries`, and answers with a typed
 * `structuredContent` payload: `{ url, title, publish_date, excerpts[] }` per
 * result. The first non-empty excerpt becomes the snippet, which is what makes
 * this backend useful to a small model — the text arrives without a second
 * `web_fetch` round trip.
 *
 * No credential is sent. Rate limiting is reported inside an HTTP 200, so the
 * payload is inspected rather than the status code.
 *
 * @module dsh-keyless-search/backends/parallel
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { KeylessSearchError } from '../errors.ts'
import { callTool, type McpToolResult } from '../mcp/client.ts'
import { clipSnippet, isCitableUrl, type Backend, type BackendSettings } from './types.ts'

export const PARALLEL_ENDPOINT = 'https://search.parallel.ai/mcp'
export const PARALLEL_TOOL = 'web_search'

/** One entry of the typed result list, as far as this backend reads it. */
interface ParallelRow {
  readonly url?: unknown
  readonly title?: unknown
  readonly publish_date?: unknown
  readonly excerpts?: unknown
}

/** The typed payload Parallel puts on `structuredContent`. */
interface ParallelPayload {
  readonly results?: unknown
  readonly warnings?: unknown
}

/**
 * Map the tool result to the seam's shape.
 *
 * @param result - the MCP tool result.
 * @param settings - caps read at call time.
 * @param limit - source cap for this request.
 * @throws {KeylessSearchError} `rate_limited` when the payload says so,
 *   `backend_error` when the payload has no results array at all.
 */
export function parseParallelResult(
  result: McpToolResult,
  settings: BackendSettings,
  limit: number,
): WebSearchResult {
  const text = result.content.join('\n')
  if (result.isError) throw classifyToolError(text)

  const payload = result.structuredContent as ParallelPayload | undefined
  const rows = payload?.results
  if (!Array.isArray(rows)) {
    // Some failures arrive as `isError: false` with an explanation in text only.
    if (detectsRateLimit(text)) throw rateLimited(text)
    throw new KeylessSearchError(
      `parallel: response has no structured results (${text.slice(0, 120) || 'empty body'})`,
      'backend_error',
    )
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const raw of rows as readonly ParallelRow[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const url = raw.url
    if (!isCitableUrl(url) || seen.has(url)) continue
    seen.add(url)

    const excerpt = firstText(raw.excerpts)
    const snippet = clipSnippet(excerpt, settings.snippetChars)
    const title = typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : undefined
    const publishedAt = typeof raw.publish_date === 'string' && raw.publish_date.length > 0 ? raw.publish_date : undefined

    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
    if (sources.length >= limit) break
  }

  if (sources.length === 0) {
    const warnings = Array.isArray(payload?.warnings) ? payload.warnings.map(String).join('; ') : ''
    throw new KeylessSearchError(
      `parallel: no citable results${warnings.length > 0 ? ` (${warnings})` : ''}`,
      'empty',
    )
  }

  return { sources, truncated: sources.length >= limit }
}

/** The first non-blank string of an excerpts array. */
function firstText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) return entry
  }
  return undefined
}

/** Endpoint phrasing for "you are asking too often". */
const RATE_LIMIT_MARKERS = [/rate.?limit/iu, /too many requests/iu, /quota/iu, /slow down/iu]

/** True when free text from the endpoint describes throttling rather than a query problem. */
export function detectsRateLimit(text: string): boolean {
  return RATE_LIMIT_MARKERS.some((marker) => marker.test(text))
}

function rateLimited(text: string): KeylessSearchError {
  const detail = text.trim().slice(0, 160).replace(/\s+/gu, ' ')
  return new KeylessSearchError(`parallel: rate limited (${detail})`, 'rate_limited')
}

/** Classify a server-signalled tool error. */
function classifyToolError(text: string): KeylessSearchError {
  if (detectsRateLimit(text)) return rateLimited(text)
  const detail = text.trim().slice(0, 160).replace(/\s+/gu, ' ') || 'tool error without text'
  return new KeylessSearchError(`parallel: ${detail}`, 'backend_error')
}

/** Options for {@link ParallelBackend}. */
export interface ParallelBackendOptions {
  /** Read the live settings (timeouts, caps) on each call. */
  readonly settings: () => BackendSettings
  /** `fetch` used for the request; injected in tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Endpoint override, mainly for self-hosted mirrors and tests. */
  readonly endpoint?: string | undefined
}

/** Parallel search, keyless. */
export class ParallelBackend implements Backend {
  readonly id = 'parallel'

  constructor(private readonly options: ParallelBackendOptions) {}

  available(): boolean {
    return true
  }

  async search(
    query: string,
    maxResults: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WebSearchResult> {
    const settings = this.options.settings()
    const limit = resolveLimit(maxResults, settings)
    const result = await callTool({
      endpoint: this.options.endpoint ?? PARALLEL_ENDPOINT,
      tool: PARALLEL_TOOL,
      args: { objective: query, search_queries: [query] },
      timeoutMs: settings.timeoutMs,
      maxBytes: settings.maxBytes,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    return parseParallelResult(result, settings, limit)
  }
}

/** The source cap for one request: the caller's bound, else the configured default. */
export function resolveLimit(maxResults: number | undefined, settings: BackendSettings): number {
  if (typeof maxResults === 'number' && Number.isInteger(maxResults) && maxResults > 0) return maxResults
  return Math.max(1, settings.maxResults)
}