import { describe, expect, it } from 'vitest'
import { parseParallelResult } from '../src/backends/parallel.ts'
import type { BackendSettings } from '../src/backends/types.ts'
import type { McpToolResult } from '../src/mcp/client.ts'

const settings: BackendSettings = { timeoutMs: 5000, maxBytes: 100_000, snippetChars: 40, maxResults: 8 }

/** Wrap a structured payload the way the endpoint does. */
function tool(structuredContent: unknown, content: string[] = []): McpToolResult {
  return { structuredContent, content, isError: false }
}

describe('parseParallelResult', () => {
  it('maps typed rows to sources with snippet and date', () => {
    const result = parseParallelResult(
      tool({
        results: [
          { url: 'https://a.example/1', title: 'A', publish_date: '2026-09-22', excerpts: ['excerpt one'] },
          { url: 'http://b.example/2', title: null, publish_date: null, excerpts: [] },
        ],
      }),
      settings,
      8,
    )
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({ url: 'https://a.example/1', title: 'A', snippet: 'excerpt one', publishedAt: '2026-09-22' })
    // A row with no excerpt and no date still yields a citable URL.
    expect(result.sources[1]).toEqual({ url: 'http://b.example/2' })
  })

  it('drops non-http urls, duplicates, and malformed rows', () => {
    const result = parseParallelResult(
      tool({
        results: [
          { url: 'javascript:alert(1)', title: 'x' },
          { url: 'https://dup.example/', title: 'first' },
          { url: 'https://dup.example/', title: 'second' },
          { url: 'not a url' },
        ],
      }),
      settings,
      8,
    )
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.title).toBe('first')
  })

  it('truncates snippets to the configured cap', () => {
    const long = 'x'.repeat(200)
    const result = parseParallelResult(tool({ results: [{ url: 'https://a.example/', excerpts: [long] }] }), settings, 8)
    const snippet = result.sources[0]?.snippet ?? ''
    expect(snippet.length).toBeLessThanOrEqual(40)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('honours the source cap and marks truncation', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ url: `https://e.example/${i}`, title: `t${i}` }))
    const result = parseParallelResult(tool({ results: rows }), settings, 2)
    expect(result.sources).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('raises rate_limited when throttling arrives as prose with a results array missing', () => {
    const result: McpToolResult = {
      content: ['You have exceeded your rate limit, slow down.'],
      isError: false,
    }
    expect(() => parseParallelResult(result, settings, 8)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
  })

  it('raises rate_limited for an isError tool result that describes throttling', () => {
    const result: McpToolResult = { content: ['429 Too Many Requests'], isError: true }
    expect(() => parseParallelResult(result, settings, 8)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
  })

  it('raises empty when the endpoint answers with no citable rows', () => {
    expect(() => parseParallelResult(tool({ results: [] }, []), settings, 8)).toThrowError(
      expect.objectContaining({ code: 'empty' }),
    )
  })

  it('raises backend_error when the payload has no results field at all', () => {
    expect(() => parseParallelResult(tool({ unexpected: true }), settings, 8)).toThrowError(
      expect.objectContaining({ code: 'backend_error' }),
    )
  })
})