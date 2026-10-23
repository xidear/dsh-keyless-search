import { describe, expect, it } from 'vitest'
import { detectsExaRateLimit, parseExaResult, parseExaText } from '../src/backends/exa.ts'
import type { BackendSettings } from '../src/backends/types.ts'
import type { McpToolResult } from '../src/mcp/client.ts'

const settings: BackendSettings = { timeoutMs: 5000, maxBytes: 100_000, snippetChars: 60, maxResults: 8 }

/** The record layout the endpoint emits, as observed from a live call. */
const ONE_RECORD = [
  'Title: Bridge passes inspection',
  'URL: https://news.example.gov.cn/2026/0922/a.shtml',
  'Published: 2026-09-22T08:52:00.000Z',
  'Author: Staff',
  'Highlights:',
  'The bridge passed final inspection.',
  '',
  'It opens within the year.',
  '---',
].join('\n')

const TWO_RECORDS = [ONE_RECORD, '', 'Title: Second', 'URL: https://second.example/', 'Highlights:', 'Body two.'].join('\n')

/** Build a tool result with the given text and optional structured meta. */
function tool(text: string, structuredContent?: unknown, isError = false): McpToolResult {
  return {
    content: [text],
    ...(structuredContent === undefined ? {} : { structuredContent }),
    isError,
  }
}

/** Build a tool result carrying the JSON-RPC `result._meta` side channel. */
function toolWithMeta(text: string, meta: Record<string, unknown>): McpToolResult {
  return { content: [text], meta, isError: false }
}

describe('parseExaText', () => {
  it('parses one record with a multi-line highlight', () => {
    const records = parseExaText([ONE_RECORD])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      title: 'Bridge passes inspection',
      url: 'https://news.example.gov.cn/2026/0922/a.shtml',
      publishedAt: '2026-09-22T08:52:00.000Z',
    })
    expect(records[0]?.snippet).toContain('final inspection')
    expect(records[0]?.snippet).toContain('opens within the year')
    // The `---` separator between excerpts is dropped.
    expect(records[0]?.snippet).not.toContain('---')
  })

  it('separates records across a single text block', () => {
    expect(parseExaText([TWO_RECORDS])).toHaveLength(2)
  })

  it('separates records split across several text blocks', () => {
    const records = parseExaText([ONE_RECORD, 'Title: Second', 'URL: https://second.example/'])
    expect(records.map((r) => r.url)).toEqual(['https://news.example.gov.cn/2026/0922/a.shtml', 'https://second.example/'])
  })

  it('ignores a record without a URL instead of emitting a sourceless citation', () => {
    expect(parseExaText(['Title: No url here', 'Highlights:', 'text'])).toHaveLength(0)
  })
})

describe('detectsExaRateLimit', () => {
  it('reads the flag from result._meta, where the endpoint actually puts it', () => {
    const throttled = toolWithMeta("You've hit Exa's free MCP rate limit.", { 'ai.exa/rateLimited': true })
    expect(detectsExaRateLimit(throttled)).toBe(true)
  })

  it('reads the prose fallback', () => {
    expect(detectsExaRateLimit(tool("You've hit Exa's free MCP rate limit."))).toBe(true)
  })

  it('does not fire on a normal record that mentions limits', () => {
    expect(detectsExaRateLimit(tool(ONE_RECORD))).toBe(false)
  })
})

describe('parseExaResult', () => {
  it('refuses a silent throttle instead of passing the upsell text through as results', () => {
    const throttled = toolWithMeta('Create an API key to continue without limits.', { 'ai.exa/rateLimited': true })
    expect(() => parseExaResult(throttled, settings, 8)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
  })

  it('maps records to sources and clips snippets', () => {
    const long = `${'word '.repeat(50)}`
    const record = `Title: T\nURL: https://a.example/\nHighlights:\n${long}`
    const result = parseExaResult(tool(record), settings, 8)
    expect(result.sources[0]?.url).toBe('https://a.example/')
    expect((result.sources[0]?.snippet ?? '').length).toBeLessThanOrEqual(60)
  })

  it('raises empty for a successful answer with no citable record', () => {
    expect(() => parseExaResult(tool('No search results found.'), settings, 8)).toThrowError(
      expect.objectContaining({ code: 'empty' }),
    )
  })

  it('raises backend_error for a tool error that is not throttling', () => {
    expect(() => parseExaResult(tool('upstream exploded', undefined, true), settings, 8)).toThrowError(
      expect.objectContaining({ code: 'backend_error' }),
    )
  })
})