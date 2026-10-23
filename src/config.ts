/**
 * Plugin configuration.
 *
 * Every knob lives here with a default, so a deployment never needs a code
 * change. The defaults reflect the two constraints this plugin exists for:
 * keyless operation and small models reading the output.
 *
 * @module dsh-keyless-search/config
 */

import z from '@deepseek-ai/schemastery'

/** Backend ids the chain understands. */
export const BACKEND_IDS = ['parallel', 'exa'] as const

/** A backend id. */
export type BackendId = (typeof BACKEND_IDS)[number]

/** Plugin config schema. */
export const Config = z.object({
  /**
   * Backends in fallback order. The first success wins; a throttled, timed-out
   * or failed backend hands over to the next one.
   *
   * `parallel` first by default: it answers in under two seconds with typed
   * results, while `exa` supplies highlights and is more prone to silent
   * throttling.
   */
  order: z.array(z.union(BACKEND_IDS)).default(['parallel', 'exa']),

  /** Request deadline per backend, in milliseconds. */
  timeoutMs: z.number().step(1).min(1000).default(8000),

  /**
   * How long a backend is skipped after throttling, a timeout, or a bot wall.
   * Skipping is deliberate: retrying a throttled endpoint immediately makes the
   * block longer, and a free tier does not recover within one query.
   */
  cooldownMs: z.number().step(1).min(0).default(120_000),

  /** Source cap when the request names none. */
  maxResults: z.number().step(1).min(1).max(20).default(8),

  /**
   * Characters kept per source snippet. 0 keeps the endpoint's text whole.
   * Small models pay for every character, and these endpoints return whole
   * paragraphs.
   */
  snippetChars: z.number().step(1).min(0).default(600),

  /** Hard cap on a response body, in bytes. */
  maxBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
})

/** Resolved configuration: what the schema produces once defaults are applied. */
export type Config = ReturnType<typeof Config>

/** The id the provider registers under; must match the bundle patch. */
export { STACK_PROVIDER_ID as PROVIDER_ID } from './stack.ts'