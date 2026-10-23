/**
 * A minimal MCP (JSON-RPC 2.0) client over Streamable HTTP.
 *
 * Only `tools/call` is needed. The two shapes servers actually answer with are
 * both handled: a plain `application/json` body, and an SSE stream whose
 * `data:` lines each carry one JSON-RPC message (the message matching our id
 * wins, so keepalive/heartbeat events are ignored rather than mistaken for a
 * result).
 *
 * The response body is read under a byte cap before parsing: a hostile or
 * broken endpoint must not be able to exhaust memory.
 *
 * @module dsh-keyless-search/mcp
 */

import { KeylessSearchError } from '../errors.ts'

/** Headers a Streamable-HTTP MCP client must send. */
const MCP_ACCEPT = 'application/json, text/event-stream'

/** One JSON-RPC request id; constant because each call is its own connection. */
const REQUEST_ID = 1

export interface McpCallOptions {
  /** Endpoint URL. */
  readonly endpoint: string
  /** Tool name to invoke. */
  readonly tool: string
  /** Tool arguments. */
  readonly args: Readonly<Record<string, unknown>>
  /** Request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Response body cap in bytes. */
  readonly maxBytes: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
  /** Extra headers (for example a version User-Agent). */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** `fetch` implementation; injected so tests never touch the network. */
  readonly fetchImpl?: typeof fetch | undefined
}

/** The `result` arm of a successful `tools/call`. */
export interface McpToolResult {
  /** Typed payload when the server provides one. */
  readonly structuredContent?: unknown
  /**
   * The JSON-RPC `result._meta` object, verbatim.
   *
   * Servers put side-channel signal here — notably a keyless endpoint flagging
   * silent throttling — so it is preserved rather than discarded when
   * `structuredContent` is read.
   */
  readonly meta?: Readonly<Record<string, unknown>> | undefined
  /** Text content blocks, in server order. */
  readonly content: readonly string[]
  /** True when the server marked the tool call as a failure. */
  readonly isError: boolean
}

/** One JSON-RPC envelope, as far as this client reads it. */
interface JsonRpcEnvelope {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/**
 * Turn a response body into JSON-RPC envelopes.
 *
 * Accepts both transports because servers differ in which they pick, and some
 * stream a single event. Non-JSON `data:` lines (keepalives, comments) are
 * skipped instead of failing the whole call.
 *
 * @param text - the raw response body.
 * @returns every envelope found, in arrival order (possibly empty).
 */
export function parseJsonRpcBody(text: string): JsonRpcEnvelope[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  // A bare JSON body is the common non-streaming answer.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.filter(isEnvelope)
    return isEnvelope(parsed) ? [parsed] : []
  }

  const envelopes: JsonRpcEnvelope[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      const parsed: unknown = JSON.parse(payload)
      if (isEnvelope(parsed)) envelopes.push(parsed)
    } catch {
      // A malformed event is a protocol problem for the message it carries, not for the
      // stream: keep reading so a later valid message can still answer this call.
    }
  }
  return envelopes
}

function isEnvelope(value: unknown): value is JsonRpcEnvelope {
  return typeof value === 'object' && value !== null
}

/** Pull the text blocks out of a `tools/call` result object. */
export function readToolResult(result: unknown): McpToolResult | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as Record<string, unknown>
  const rawContent = record['content']
  const content: string[] = []
  if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (typeof block !== 'object' || block === null) continue
      const entry = block as Record<string, unknown>
      if (typeof entry['text'] === 'string') content.push(entry['text'])
    }
  }
  const rawMeta = record['_meta']
  return {
    ...(record['structuredContent'] === undefined
      ? {}
      : { structuredContent: record['structuredContent'] }),
    ...(typeof rawMeta === 'object' && rawMeta !== null && !Array.isArray(rawMeta)
      ? { meta: rawMeta as Record<string, unknown> }
      : {}),
    content,
    isError: record['isError'] === true,
  }
}

/**
 * Map an HTTP status onto a search failure.
 *
 * 429 and 403 are the two shapes a keyless endpoint uses to say "stop"; both are
 * cooldown-worthy. A 400 means our request was malformed, which no retry fixes.
 */
function codeForStatus(status: number): 'rate_limited' | 'forbidden' | 'auth_failed' | 'bad_request' | 'backend_error' {
  if (status === 429) return 'rate_limited'
  if (status === 403) return 'forbidden'
  if (status === 401) return 'auth_failed'
  if (status === 400) return 'bad_request'
  return 'backend_error'
}

/**
 * Perform one `tools/call`.
 *
 * @returns the tool result; a server-signalled tool error is returned with
 *   `isError: true` so the caller can inspect its text (keyless endpoints
 *   report rate limiting that way, inside an HTTP 200).
 * @throws {KeylessSearchError} on transport, HTTP, or protocol failure.
 */
export async function callTool(options: McpCallOptions): Promise<McpToolResult> {
  const call = options.fetchImpl ?? fetch
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

  const body = {
    jsonrpc: '2.0',
    id: REQUEST_ID,
    method: 'tools/call',
    params: { name: options.tool, arguments: options.args },
  }

  let response: Response
  try {
    response = await call(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
        ...options.headers,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    throw classifyTransportError(error, deadline, options)
  }

  const text = await readBounded(response, options.maxBytes, deadline, options)

  if (!response.ok) {
    throw new KeylessSearchError(
      `${options.tool}: HTTP ${response.status}`,
      codeForStatus(response.status),
    )
  }

  let envelopes: JsonRpcEnvelope[]
  try {
    envelopes = parseJsonRpcBody(text)
  } catch (error) {
    throw new KeylessSearchError(`${options.tool}: unparseable response body`, 'backend_error', {
      cause: error,
    })
  }

  const answer =
    envelopes.find((envelope) => envelope.id === REQUEST_ID && (envelope.result ?? envelope.error) !== undefined) ??
    envelopes.find((envelope) => envelope.result !== undefined || envelope.error !== undefined)

  if (answer === undefined) {
    throw new KeylessSearchError(`${options.tool}: response carried no JSON-RPC result`, 'backend_error')
  }
  if (answer.error !== undefined) {
    const message = typeof answer.error.message === 'string' ? answer.error.message : 'unknown tool error'
    throw new KeylessSearchError(`${options.tool}: ${message}`, 'backend_error')
  }

  const result = readToolResult(answer.result)
  if (result === undefined) {
    throw new KeylessSearchError(`${options.tool}: result was not a tool result object`, 'backend_error')
  }
  return result
}

/** Classify a `fetch` rejection: caller abort, deadline, or transport fault. */
function classifyTransportError(
  error: unknown,
  deadline: AbortSignal,
  options: McpCallOptions,
): KeylessSearchError {
  if (options.signal?.aborted === true) {
    return new KeylessSearchError(`${options.tool}: search aborted by caller`, 'aborted', { cause: error })
  }
  if (deadline.aborted) {
    return new KeylessSearchError(`${options.tool}: timed out after ${options.timeoutMs}ms`, 'timeout', {
      cause: error,
    })
  }
  return new KeylessSearchError(`${options.tool}: request failed (${describe(error)})`, 'backend_error', {
    cause: error,
  })
}

/**
 * Read a response body without exceeding `maxBytes`.
 *
 * The declared `content-length` is checked first so an oversized body is
 * refused before it is buffered; a chunked body is still counted as it arrives.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
  deadline: AbortSignal,
  options: McpCallOptions,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new KeylessSearchError(
      `${options.tool}: response is ${declared} bytes, over the ${maxBytes}-byte cap`,
      'backend_error',
    )
  }

  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new KeylessSearchError(
          `${options.tool}: response exceeded the ${maxBytes}-byte cap`,
          'backend_error',
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (deadline.aborted) {
      throw new KeylessSearchError(`${options.tool}: timed out while reading the body`, 'timeout', {
        cause: error,
      })
    }
    if (error instanceof KeylessSearchError) throw error
    throw new KeylessSearchError(`${options.tool}: failed while reading the body`, 'backend_error', {
      cause: error,
    })
  } finally {
    reader.releaseLock()
  }

  return new TextDecoder().decode(concat(chunks, total))
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // `fetch` wraps the useful part in `cause` for network faults.
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message.length > 0) return cause.message
    return error.message
  }
  return String(error)
}