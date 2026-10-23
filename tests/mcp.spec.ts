import { describe, expect, it } from 'vitest'
import { callTool, parseJsonRpcBody } from '../src/mcp/client.ts'
import { KeylessSearchError } from '../src/errors.ts'

/** Build a `fetch` stand-in that answers once with the given body/status. */
function fetchOnce(body: string, init: { status?: number; headers?: Record<string, string> } = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: init.headers ?? { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const okPayload = {
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: 'hello' }], structuredContent: { rows: [1] } },
}

describe('parseJsonRpcBody', () => {
  it('reads a bare JSON body', () => {
    const envelopes = parseJsonRpcBody(JSON.stringify(okPayload))
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.result).toBeDefined()
  })

  it('reads the message out of an SSE stream and ignores keepalives', () => {
    const body = [': ping', '', `data: ${JSON.stringify(okPayload)}`, ''].join('\n')
    const envelopes = parseJsonRpcBody(body)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]?.id).toBe(1)
  })

  it('survives a malformed event without losing the valid one', () => {
    const body = ['data: {not json', `data: ${JSON.stringify(okPayload)}`].join('\n')
    expect(parseJsonRpcBody(body)).toHaveLength(1)
  })

  it('returns nothing for an empty body', () => {
    expect(parseJsonRpcBody('   ')).toEqual([])
  })
})

describe('callTool', () => {
  const base = {
    endpoint: 'https://example.invalid/mcp',
    tool: 'web_search',
    args: { q: 'x' },
    timeoutMs: 2000,
    maxBytes: 10_000,
  }

  it('returns text blocks and structured content', async () => {
    const result = await callTool({ ...base, fetchImpl: fetchOnce(JSON.stringify(okPayload)) })
    expect(result.content).toEqual(['hello'])
    expect(result.structuredContent).toEqual({ rows: [1] })
    expect(result.isError).toBe(false)
  })

  it('picks the message matching the request id out of several events', async () => {
    const other = { jsonrpc: '2.0', method: 'notifications/progress', params: {} }
    const sse = `data: ${JSON.stringify(other)}\n\ndata: ${JSON.stringify(okPayload)}\n`
    const result = await callTool({ ...base, fetchImpl: fetchOnce(sse, { headers: { 'content-type': 'text/event-stream' } }) })
    expect(result.content).toEqual(['hello'])
  })

  it('classifies 429 as rate_limited', async () => {
    const promise = callTool({ ...base, fetchImpl: fetchOnce('{}', { status: 429 }) })
    await expect(promise).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('classifies 403 as forbidden and 400 as bad_request', async () => {
    await expect(callTool({ ...base, fetchImpl: fetchOnce('', { status: 403 }) })).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(callTool({ ...base, fetchImpl: fetchOnce('', { status: 400 }) })).rejects.toMatchObject({
      code: 'bad_request',
    })
  })

  it('rejects a body over the declared byte cap before reading it', async () => {
    const promise = callTool({
      ...base,
      maxBytes: 100,
      fetchImpl: fetchOnce(JSON.stringify(okPayload), { headers: { 'content-length': '9000' } }),
    })
    await expect(promise).rejects.toBeInstanceOf(KeylessSearchError)
    await expect(promise).rejects.toMatchObject({ code: 'backend_error' })
  })

  it('reports a transport failure as backend_error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })
    }) as unknown as typeof fetch
    const promise = callTool({ ...base, fetchImpl: failing })
    await expect(promise).rejects.toMatchObject({ code: 'backend_error' })
    await expect(promise).rejects.toThrow(/ENOTFOUND/)
  })

  it('reports a caller abort as aborted, not as a backend fault', async () => {
    const controller = new AbortController()
    // Reject as soon as the fused signal fires, whichever source aborted it.
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch

    const pending = callTool({ ...base, signal: controller.signal, fetchImpl: hanging })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })

  it('preserves result._meta, where endpoints put side-channel signal', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { _meta: { 'ai.exa/rateLimited': true }, content: [{ type: 'text', text: 'throttled' }] },
    })
    const result = await callTool({ ...base, fetchImpl: fetchOnce(body) })
    expect(result.meta).toEqual({ 'ai.exa/rateLimited': true })
  })

  it('surfaces a JSON-RPC error envelope as backend_error', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })
    await expect(callTool({ ...base, fetchImpl: fetchOnce(body) })).rejects.toMatchObject({
      code: 'backend_error',
    })
  })
})