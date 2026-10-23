/**
 * Plugin entry point.
 *
 * Registers one `ctx.web` search provider that runs a keyless fallback chain.
 * Selection still belongs to dsh: the row is pinned to the provider id from
 * `cordis.patch.yml`, so `web_search` keeps working with no further wiring.
 *
 * @module dsh-keyless-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { ExaBackend } from './backends/exa.ts'
import { ParallelBackend } from './backends/parallel.ts'
import type { Backend, BackendSettings } from './backends/types.ts'
import { Config as ConfigSchema, type BackendId, type Config } from './config.ts'
import { KeylessStackProvider } from './stack.ts'

export { Config } from './config.ts'
export { KeylessSearchError, isCooldownWorthy, isRecoverable } from './errors.ts'
export type { SearchErrorCode } from './errors.ts'
export { KeylessStackProvider, STACK_PROVIDER_ID } from './stack.ts'
export { EXA_ENDPOINT, EXA_TOOL, ExaBackend, parseExaResult, parseExaText } from './backends/exa.ts'
export { PARALLEL_ENDPOINT, PARALLEL_TOOL, ParallelBackend, parseParallelResult } from './backends/parallel.ts'
export { callTool, parseJsonRpcBody } from './mcp/client.ts'
export { clipSnippet } from './backends/types.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'keyless-search'

/** The seam this plugin contributes a search provider to. */
export const inject = ['web']

/** Schema re-exported for the loader. */
export const Schema = ConfigSchema

/** Translate plugin config into the settings each backend reads per call. */
function settingsOf(config: Config): BackendSettings {
  return {
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
    snippetChars: config.snippetChars,
    maxResults: config.maxResults,
  }
}

/**
 * Register the keyless chain with `ctx.web`.
 *
 * Settings are read through a closure rather than captured, so an edit lands on
 * the next search instead of at the next restart.
 */
export function apply(ctx: Context, config: Config): void {
  const order = [...config.order]
  if (order.length === 0) {
    // Fail loud: a chain with no backend would fail every search with an
    // unhelpful "unavailable" long after the misconfiguration was made.
    throw new Error('dsh-keyless-search: `order` is empty; configure at least one backend (parallel, exa)')
  }

  const settings = (): BackendSettings => settingsOf(config)

  const backends = new Map<string, Backend>()
  backends.set('parallel', new ParallelBackend({ settings }))
  backends.set('exa', new ExaBackend({ settings }))

  for (const id of order) {
    if (!backends.has(id as BackendId)) {
      // Fail loud on an unknown id instead of silently searching with fewer
      // backends than the operator believes are configured.
      throw new Error(`dsh-keyless-search: unknown backend ${JSON.stringify(id)}; known: ${[...backends.keys()].join(', ')}`)
    }
  }

  const provider = new KeylessStackProvider({
    order: () => order,
    backendOf: (id) => backends.get(id),
    cooldownMs: () => config.cooldownMs,
    maxResults: () => config.maxResults,
  })

  const dispose = ctx.web.registerSearchProvider(provider)
  ctx.effect(() => dispose)
}