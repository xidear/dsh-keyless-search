/**
 * Exa's public MCP endpoint as a keyless backend.
 *
 * There are two ways in: the REST API (requires a key) and the public MCP
 * server, which answers an anonymous `web_search_exa` call. This backend uses
 * the MCP route, so it works with no configuration at all.
 *
 * The important property of this endpoint is that throttling is *silent*: it
 * answers HTTP 200 and puts a machine-readable
 * `result._meta["ai.exa/rateLimited"] === true` next to an English prompt as
 * the tool's text. Passing that through would hand a model a plausible-looking
 * search result that is actually an advertisement for an API key, so
 * {@link parseExaResult} refuses it and raises `rate_limited`.
 *
 * The text blocks are a `Title: / URL: / Published: / Author: / Highlights:`
 * record per result, which this module parses into the seam's shape.
 *
 * @module dsh-keyless-search/backends/exa
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { KeylessSearchError } from '../errors.ts'
import { callTool, type McpToolResult } from '../mcp/client.ts'
import { clipSnippet, isCitableUrl, type Backend, type BackendSettings } from './types.ts'

export const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp'
export const EXA_TOOL = 'web_search_exa'

/** Key the endpoint sets on `result._meta` when it is throttling but still answers 200. */
export const RATE_LIMIT_FLAG = 'ai.exa/rateLimited'

/** One parsed record from the endpoint's text blocks. */
export interface ExaRecord {
  readonly title?: string
  readonly url: string
  readonly publishedAt?: string
  readonly snippet?: string
}

/** Field labels that start a new record; everything else belongs to the previous one. */
const FIELD_LABELS = ['Title', 'URL', 'Published', 'Author', 'Highlights'] as const
type FieldLabel = (typeof FIELD_LABELS)[number]

/**
 * Parse the endpoint's text blocks into records.
 *
 * A record begins at a `Title:` line and ends at the next `Title:` (or the end
 * of the blocks). Multi-line `Highlights:` bodies are kept together; `...`
 * separators the endpoint inserts between excerpts are dropped.
 *
 * @param blocks - the tool result's text content, in order.
 * @returns one record per `URL:` seen, in order.
 */
export function parseExaText(blocks: readonly string[]): ExaRecord[] {
  const records: ExaRecord[] = []
  let current: { title?: string; url?: string; published?: string; highlights: string[] } | undefined
  let activeField: FieldLabel | undefined

  const flush = (): void => {
    if (current?.url !== undefined) {
      const snippet = current.highlights.join('\n').trim()
      records.push({
        ...(current.title === undefined ? {} : { title: current.title }),
        url: current.url,
        ...(current.published === undefined ? {} : { publishedAt: current.published }),
        ...(snippet.length === 0 ? {} : { snippet }),
      })
    }
    current = undefined
    activeField = undefined
  }

  for (const block of blocks) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      const field = readField(line)
      if (field !== undefined) {
        if (field === 'Title') flush()
        current ??= { highlights: [] }
        activeField = field
        const value = line.slice(line.indexOf(':') + 1).trim()
        if (field === 'Title' && value.length > 0) current.title = value
        else if (field === 'URL' && value.length > 0) current.url = value
        else if (field === 'Published' && value.length > 0) current.published = value
        continue
      }
      if (activeField === 'Highlights' && current !== undefined) {
        const value = line.trim()
        // `...` separates excerpts within a record; `---` closes it (the endpoint emits
        // both). Neither is prose, so neither becomes part of the snippet.
        if (value.length > 0 && value !== '...' && !/^(?:-{3,}|…)$/u.test(value)) {
          current.highlights.push(value)
        }
      }
    }
  }
  flush()
  return records
}

/** Recognise a `Label:` line at the start of a record field. */
function readField(line: string): FieldLabel | undefined {
  const match = /^(Title|URL|Published|Author|Highlights):/u.exec(line)
  if (match === null) return undefined
  return match[1] as FieldLabel
}

/**
 * True when the endpoint flagged this answer as throttled.
 *
 * The flag is authoritative and lives on the JSON-RPC `result._meta`; it is
 * checked before any text, because the accompanying prose is an upsell for an
 * API key rather than a description of the failure.
 */
export function detectsExaRateLimit(result: McpToolResult): boolean {
  if (result.meta?.[RATE_LIMIT_FLAG] === true) return true

  // Some servers relay the same flag inside their typed payload.
  const structured = result.structuredContent
  if (typeof structured === 'object' && structured !== null) {
    const nested = (structured as Record<string, unknown>)['_meta']
    if (typeof nested === 'object' && nested !== null) {
      if ((nested as Record<string, unknown>)[RATE_LIMIT_FLAG] === true) return true
    }
  }

  // Last resort: prose, for a shape neither of the above covers.
  return /rate.?limit/iu.test(result.content.join('\n'))
}

/**
 * Map a tool result to the seam's shape.
 *
 * @throws {KeylessSearchError} `rate_limited` when the endpoint says so (even
 *   though the HTTP status was 200), `empty` when it succeeded with no citable
 *   record.
 */
export function parseExaResult(
  result: McpToolResult,
  settings: BackendSettings,
  limit: number,
): WebSearchResult {
  if (detectsExaRateLimit(result)) {
    const detail = result.content.join(' ').trim().slice(0, 160).replace(/\s+/gu, ' ')
    throw new KeylessSearchError(`exa: rate limited (${detail})`, 'rate_limited')
  }
  if (result.isError) {
    const detail = result.content.join(' ').trim().slice(0, 160).replace(/\s+/gu, ' ')
    throw new KeylessSearchError(`exa: ${detail || 'tool error without text'}`, 'backend_error')
  }

  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const record of parseExaText(result.content)) {
    if (!isCitableUrl(record.url) || seen.has(record.url)) continue
    seen.add(record.url)
    const snippet = clipSnippet(record.snippet, settings.snippetChars)
    sources.push({
      url: record.url,
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    })
    if (sources.length >= limit) break
  }

  if (sources.length === 0) {
    throw new KeylessSearchError('exa: no citable results', 'empty')
  }
  return { sources, truncated: sources.length >= limit }
}

/** Options for {@link ExaBackend}. */
export interface ExaBackendOptions {
  /** Read the live settings (timeouts, caps) on each call. */
  readonly settings: () => BackendSettings
  /** `fetch` used for the request; injected in tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Endpoint override, mainly for tests. */
  readonly endpoint?: string | undefined
}

/** Exa search over its keyless MCP endpoint. */
export class ExaBackend implements Backend {
  readonly id = 'exa'

  constructor(private readonly options: ExaBackendOptions) {}

  available(): boolean {
    return true
  }

  async search(
    query: string,
    maxResults: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<WebSearchResult> {
    const settings = this.options.settings()
    const limit =
      typeof maxResults === 'number' && Number.isInteger(maxResults) && maxResults > 0
        ? maxResults
        : Math.max(1, settings.maxResults)

    const result = await callTool({
      endpoint: this.options.endpoint ?? EXA_ENDPOINT,
      tool: EXA_TOOL,
      args: { query, numResults: limit },
      timeoutMs: settings.timeoutMs,
      maxBytes: settings.maxBytes,
      ...(signal === undefined ? {} : { signal }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    })
    return parseExaResult(result, settings, limit)
  }
}