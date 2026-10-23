/**
 * The fallback chain registered on `ctx.web`.
 *
 * `ctx.web` selects exactly one provider per capability, so a chain cannot be
 * expressed as several registrations — it lives inside this one provider.
 *
 * Three behaviours matter operationally:
 *
 * 1. **Ordered fallback.** Backends run in configured order; a recoverable
 *    failure hands over to the next one.
 * 2. **Cooldown.** A backend that reports throttling, a timeout, or a bot wall
 *    is skipped for a while. Hammering a rate-limited endpoint only extends the
 *    block, and a free tier that is throttled will still be throttled on the
 *    next query in the same second.
 * 3. **Honest failure.** When everything fails, the error carries one line per
 *    backend. The chain never returns an empty result set as if it succeeded,
 *    and never passes an endpoint's "please buy an API key" text through as
 *    search content.
 *
 * @module dsh-keyless-search/stack
 */

import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { Backend, BackendSettings } from './backends/types.ts'
import { KeylessSearchError, isCooldownWorthy, isRecoverable, type SearchErrorCode } from './errors.ts'

/** One failed attempt, kept for the final error message. */
export interface Attempt {
  readonly backend: string
  readonly code: SearchErrorCode
  readonly message: string
}

/** Read-only view of the chain's health, for diagnostics and tests. */
export interface StackStatus {
  /** Backend ids in configured order. */
  readonly order: readonly string[]
  /** Backend ids currently parked, with the reason and remaining milliseconds. */
  readonly cooling: readonly { readonly backend: string; readonly remainingMs: number; readonly reason: string }[]
}

/** Options for {@link KeylessStackProvider}. */
export interface StackOptions {
  /** Backend ids in fallback order, read per call so a config edit lands immediately. */
  readonly order: () => readonly string[]
  /** Resolve one backend id. */
  readonly backendOf: (id: string) => Backend | undefined
  /** Cooldown duration after a cooldown-worthy failure, read per call. */
  readonly cooldownMs: () => number
  /** Default source cap when a request names none. */
  readonly maxResults: () => number
  /** Clock, injected for tests. */
  readonly now?: (() => number) | undefined
}

/** A cooldown entry: when it ends and why it was set. */
interface Parked {
  readonly until: number
  readonly reason: string
}

export const STACK_PROVIDER_ID = 'keyless-search'

/** Runs the configured backends in order and returns the first success. */
export class KeylessStackProvider implements WebSearchProvider {
  readonly id = STACK_PROVIDER_ID

  private readonly parked = new Map<string, Parked>()
  private readonly clock: () => number

  constructor(private readonly options: StackOptions) {
    this.clock = options.now ?? Date.now
  }

  /**
   * True when at least one configured backend is enabled and not parked.
   *
   * `ctx.web` asks this before selecting the provider. Returning false makes
   * the failure explicit (`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`) instead of
   * letting every search fail one by one.
   */
  available(): boolean {
    const now = this.clock()
    return this.enabledBackends().some((backend) => !this.isParked(backend.id, now))
  }

  /** Snapshot of the chain for diagnostics. */
  status(): StackStatus {
    const now = this.clock()
    const cooling: { backend: string; remainingMs: number; reason: string }[] = []
    for (const [backend, entry] of this.parked) {
      if (entry.until > now) cooling.push({ backend, remainingMs: entry.until - now, reason: entry.reason })
    }
    return { order: [...this.options.order()], cooling }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = typeof request.query === 'string' ? request.query.trim() : ''
    if (query.length === 0) throw new KeylessSearchError('query must be a non-empty string', 'bad_request')

    const backends = this.enabledBackends()
    if (backends.length === 0) {
      throw new KeylessSearchError('no search backend is configured and enabled', 'unavailable')
    }

    const attempts: Attempt[] = []
    const now = this.clock()

    for (const backend of backends) {
      if (signal?.aborted === true) throw new KeylessSearchError('search aborted by caller', 'aborted')

      const parked = this.parked.get(backend.id)
      if (parked !== undefined && parked.until > now) {
        attempts.push({
          backend: backend.id,
          code: 'rate_limited',
          message: `cooling down for ${Math.ceil((parked.until - now) / 1000)}s after: ${parked.reason}`,
        })
        continue
      }

      try {
        return await backend.search(query, request.maxResults, signal)
      } catch (error) {
        // `signal?.aborted` was checked at the top of the loop and nothing above can
        // re-abort it, so the narrowing is sound rather than a missed case.
        if (signal?.aborted) throw new KeylessSearchError('search aborted by caller', 'aborted')

        const { code, message } =
          error instanceof KeylessSearchError
            ? { code: error.code, message: error.message }
            : { code: 'backend_error' as const, message: error instanceof Error ? error.message : String(error) }

        attempts.push({ backend: backend.id, code, message })

        if (isCooldownWorthy(code)) {
          const cooldown = Math.max(0, this.options.cooldownMs())
          if (cooldown > 0) this.parked.set(backend.id, { until: this.clock() + cooldown, reason: message })
        }

        // A malformed request would fail identically on every backend, and an abort is the
        // caller's decision: neither is worth trying elsewhere.
        if (!isRecoverable(code)) throw error instanceof KeylessSearchError ? error : wrap(code, message)
      }
    }

    throw new KeylessSearchError(
      `all search backends failed (${attempts.map((a) => `${a.backend}: ${a.code} — ${a.message}`).join('; ')})`,
      'unavailable',
    )
  }

  /** Configured backends that exist and report themselves usable, in order. */
  private enabledBackends(): readonly Backend[] {
    const resolved: Backend[] = []
    for (const id of this.options.order()) {
      const backend = this.options.backendOf(id)
      // An id the entry point already rejected never reaches here; skipping an unknown one
      // keeps a stale config row from failing every search at runtime.
      if (backend !== undefined && backend.available()) resolved.push(backend)
    }
    return resolved
  }

  private isParked(id: string, now: number): boolean {
    const parked = this.parked.get(id)
    return parked !== undefined && parked.until > now
  }
}

function wrap(code: SearchErrorCode, message: string): KeylessSearchError {
  return new KeylessSearchError(message, code)
}

/** Settings adapter used by the plugin entry point. */
export type SettingsReader = () => BackendSettings