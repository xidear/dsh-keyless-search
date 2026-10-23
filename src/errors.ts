/**
 * Error vocabulary for the fallback chain.
 *
 * The chain routes on `code`, never on message text, so every backend must
 * classify its failures into one of these. `RECOVERABLE` decides whether a
 * failure moves to the next backend or aborts the whole search.
 *
 * @module dsh-keyless-search/errors
 */

/** A search failure carrying a stable, machine-routable code. */
export class KeylessSearchError extends Error {
  readonly code: SearchErrorCode

  constructor(message: string, code: SearchErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = 'KeylessSearchError'
  }
}

/**
 * Failure classes.
 *
 * - `backend_error` — the endpoint answered but the payload was unusable.
 * - `rate_limited` — the endpoint said (explicitly or implicitly) "slow down".
 * - `timeout` — the deadline fired.
 * - `unavailable` — the backend cannot run here (missing config, disabled).
 * - `auth_failed` — a credential was rejected; terminal for that backend only.
 * - `forbidden` — the endpoint refused the request outright (WAF, bot wall).
 * - `bad_request` — our request was rejected as malformed; a real bug, terminal.
 * - `aborted` — the caller cancelled. Never a backend fault.
 * - `empty` — the endpoint succeeded but produced nothing usable.
 */
export type SearchErrorCode =
  | 'backend_error'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'auth_failed'
  | 'forbidden'
  | 'bad_request'
  | 'aborted'
  | 'empty'

/**
 * Codes that let the chain continue to the next backend.
 *
 * `empty` is recoverable on purpose: one engine producing nothing for a query
 * says nothing about the others. `bad_request` and `aborted` are not — the
 * first would fail identically everywhere, the second is the caller's decision.
 */
const RECOVERABLE: ReadonlySet<SearchErrorCode> = new Set<SearchErrorCode>([
  'backend_error',
  'rate_limited',
  'timeout',
  'unavailable',
  'auth_failed',
  'forbidden',
  'empty',
])

/** True when a failure should hand over to the next backend instead of aborting. */
export function isRecoverable(code: SearchErrorCode): boolean {
  return RECOVERABLE.has(code)
}

/** True when a failure means "this backend needs a rest", not "this query is bad". */
export function isCooldownWorthy(code: SearchErrorCode): boolean {
  return code === 'rate_limited' || code === 'timeout' || code === 'forbidden'
}