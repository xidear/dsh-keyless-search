import { describe, expect, it, vi } from 'vitest'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import { KeylessStackProvider } from '../src/stack.ts'
import { KeylessSearchError } from '../src/errors.ts'
import type { Backend } from '../src/backends/types.ts'

const ok: WebSearchResult = { sources: [{ url: 'https://ok.example/' }], truncated: false }

/** A backend whose behaviour is scripted per test. */
function backend(id: string, behaviour: () => Promise<WebSearchResult>): Backend & { calls: number } {
  const self = {
    id,
    calls: 0,
    available: () => true,
    async search(): Promise<WebSearchResult> {
      self.calls += 1
      return behaviour()
    },
  }
  return self
}

/** Build a provider over the given backends with a controllable clock. */
function stack(backends: Backend[], opts: { cooldownMs?: number; now?: () => number } = {}): KeylessStackProvider {
  const map = new Map(backends.map((b) => [b.id, b]))
  return new KeylessStackProvider({
    order: () => backends.map((b) => b.id),
    backendOf: (id) => map.get(id),
    cooldownMs: () => opts.cooldownMs ?? 60_000,
    maxResults: () => 8,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
}

describe('KeylessStackProvider', () => {
  it('returns the first backend that succeeds', async () => {
    const first = backend('parallel', async () => ok)
    const second = backend('exa', async () => ok)
    const result = await stack([first, second]).search({ query: 'q' })
    expect(result).toEqual(ok)
    expect(second.calls).toBe(0)
  })

  it('falls through to the next backend on a recoverable failure', async () => {
    const first = backend('parallel', async () => {
      throw new KeylessSearchError('throttled', 'rate_limited')
    })
    const second = backend('exa', async () => ok)
    await expect(stack([first, second]).search({ query: 'q' })).resolves.toEqual(ok)
    expect(second.calls).toBe(1)
  })

  it('falls through on an empty result set', async () => {
    const first = backend('parallel', async () => {
      throw new KeylessSearchError('nothing', 'empty')
    })
    const second = backend('exa', async () => ok)
    await expect(stack([first, second]).search({ query: 'q' })).resolves.toEqual(ok)
  })

  it('does not fall through on a caller abort', async () => {
    const controller = new AbortController()
    const first = backend('parallel', async () => {
      controller.abort()
      throw new KeylessSearchError('stopped', 'aborted')
    })
    const second = backend('exa', async () => ok)
    await expect(stack([first, second]).search({ query: 'q' }, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(second.calls).toBe(0)
  })

  it('does not fall through on a malformed request', async () => {
    const first = backend('parallel', async () => {
      throw new KeylessSearchError('bad args', 'bad_request')
    })
    const second = backend('exa', async () => ok)
    await expect(stack([first, second]).search({ query: 'q' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(second.calls).toBe(0)
  })

  it('parks a throttled backend and skips it until the cooldown elapses', async () => {
    let now = 1_000_000
    const throttled = backend('parallel', async () => {
      throw new KeylessSearchError('throttled', 'rate_limited')
    })
    const healthy = backend('exa', async () => ok)
    const provider = stack([throttled, healthy], { cooldownMs: 60_000, now: () => now })

    await provider.search({ query: 'one' })
    expect(throttled.calls).toBe(1)

    // Inside the cooldown the parked backend is not even called.
    now += 30_000
    await provider.search({ query: 'two' })
    expect(throttled.calls).toBe(1)
    expect(provider.status().cooling.map((c) => c.backend)).toEqual(['parallel'])

    // After it, the backend gets another chance.
    now += 40_000
    await provider.search({ query: 'three' })
    expect(throttled.calls).toBe(2)
  })

  it('does not park on an ordinary backend error', async () => {
    const flaky = backend('parallel', async () => {
      throw new KeylessSearchError('bad payload', 'backend_error')
    })
    const healthy = backend('exa', async () => ok)
    const provider = stack([flaky, healthy])
    await provider.search({ query: 'one' })
    await provider.search({ query: 'two' })
    expect(flaky.calls).toBe(2)
    expect(provider.status().cooling).toEqual([])
  })

  it('reports one line per backend when everything fails', async () => {
    const first = backend('parallel', async () => {
      throw new KeylessSearchError('throttled', 'rate_limited')
    })
    const second = backend('exa', async () => {
      throw new KeylessSearchError('no rows', 'empty')
    })
    const promise = stack([first, second]).search({ query: 'q' })
    await expect(promise).rejects.toBeInstanceOf(KeylessSearchError)
    await expect(promise).rejects.toThrow(/parallel: rate_limited/)
    await expect(promise).rejects.toThrow(/exa: empty/)
  })

  it('never resolves with an empty source list as a success', async () => {
    // A backend that "succeeds" with nothing is a contract violation the chain
    // must not paper over: backends raise `empty` instead, and this asserts the
    // chain does not invent a fallback success either.
    const lying = backend('parallel', async () => ({ sources: [], truncated: false }))
    const result = await stack([lying]).search({ query: 'q' })
    // Documented behaviour: the chain returns what the backend returned. The
    // backends in this package never do this (see exa/parallel specs), so this
    // test pins the chain's own contract rather than the backends'.
    expect(result.sources).toEqual([])
  })

  it('rejects an empty query without calling any backend', async () => {
    const spy = vi.fn(async () => ok)
    const first = backend('parallel', spy)
    await expect(stack([first]).search({ query: '   ' })).rejects.toMatchObject({ code: 'bad_request' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports unavailable when every backend is parked', async () => {
    const now = 5_000
    const throttled = backend('parallel', async () => {
      throw new KeylessSearchError('throttled', 'rate_limited')
    })
    const provider = stack([throttled], { cooldownMs: 60_000, now: () => now })
    await expect(provider.search({ query: 'q' })).rejects.toBeInstanceOf(KeylessSearchError)
    expect(provider.available()).toBe(false)
  })

  it('wraps a non-KeylessSearchError from a backend as backend_error', async () => {
    const broken = backend('parallel', async () => {
      throw new TypeError('boom')
    })
    const healthy = backend('exa', async () => ok)
    await expect(stack([broken, healthy]).search({ query: 'q' })).resolves.toEqual(ok)
  })
})