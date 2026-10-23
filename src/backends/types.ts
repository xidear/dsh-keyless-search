/**
 * Shared backend vocabulary.
 *
 * @module dsh-keyless-search/backends/types
 */

import type { WebSearchResult } from '@deepseek-ai/dsh-web'

/** What every backend reads at call time, so config edits land without a restart. */
export interface BackendSettings {
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Hard cap on a response body, in bytes. */
  readonly maxBytes: number
  /** Per-source snippet cap, in characters. 0 keeps the provider's text intact. */
  readonly snippetChars: number
  /** Default source count when the request names none. */
  readonly maxResults: number
}

/** One search backend: an endpoint plus the mapping from its payload to the seam's shape. */
export interface Backend {
  /** Stable id, also the config name and the diagnostics label. */
  readonly id: string
  /** Cheap local check; never touches the network. */
  available(): boolean
  /** Run one search. */
  search(query: string, maxResults: number | undefined, signal: AbortSignal | undefined): Promise<WebSearchResult>
}

/**
 * Cut a snippet to `maxChars` characters.
 *
 * Truncation matters for the small models this plugin targets: a single
 * search that injects several kilobytes per source can crowd out the actual
 * conversation. The cut respects surrogate pairs so it never emits a broken
 * character.
 *
 * @param text - source text, possibly long.
 * @param maxChars - character cap; 0 or negative disables truncation.
 * @returns the (possibly shortened) text, or undefined when nothing remains.
 */
export function clipSnippet(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return undefined
  if (maxChars <= 0 || normalized.length <= maxChars) return normalized

  // Use the character iterator so a cut never lands inside a surrogate pair.
  let out = ''
  let count = 0
  for (const char of normalized) {
    if (count + char.length > maxChars - 1) break
    out += char
    count += char.length
  }
  return `${out.trimEnd()}…`
}

/** Keep only absolute http(s) URLs; search results are citations and must be clickable. */
export function isCitableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}