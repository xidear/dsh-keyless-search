# dsh-keyless-search

A keyless web search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

It registers one provider on the `ctx.web` seam that runs an **ordered fallback
chain** over public MCP search endpoints. No API key, no signup, no model call,
no per-search bill.

The point of the fallback chain is not redundancy for its own sake. Keyless
endpoints throttle, and they throttle *quietly*: one of them answers HTTP 200
and puts "you have hit the free limit, create an API key" into the tool text.
A model reading that as a search result will cite it. This plugin refuses
pseudo-success, parks the offending backend, and moves to the next one.

## What it does

- **Two backends, ordered.** `parallel` answers first by default: typed results
  in about two seconds, each with a title, URL, publication date, and excerpts.
  `exa` follows: same shape, richer highlight text, more likely to throttle.
- **Pseudo-success detection.** A 200 with a rate-limit flag, an upsell page, or
  no citable rows is treated as a failure, never as content. Throttling is
  matched on the endpoint's own machine-readable flag first, prose second.
- **Cooldown.** A backend that throttles, times out, or hits a bot wall is
  skipped for `cooldownMs`. Retrying a throttled free tier immediately only
  extends the block.
- **Honest failure.** When every backend fails, the error lists one line per
  backend. The chain never returns an empty result set dressed up as success.
- **Snippet trimming.** Small models pay for every character, and these
  endpoints return whole paragraphs. `snippetChars` caps each source.
- **No silent spend.** The bundle patch disables the billed
  `deepseek-official` search route, so a stray config pointing at it fails
  loudly instead of charging for a model turn.

## Install

```bash
dsh plugin add dsh-keyless-search
```

The package carries its own bundle patch, so the provider row is inserted and
pinned automatically. Restart `dsh web` and `web_search` uses the chain.

To use it from a local checkout:

```bash
dsh plugin add /path/to/dsh-keyless-search
```

## Configuration

All settings have defaults; change them only when you need to. They are read on
every search, so an edit takes effect without a restart.

| Key | Default | Meaning |
|---|---|---|
| `order` | `[parallel, exa]` | Backend order. First success wins. |
| `timeoutMs` | `8000` | Per-request deadline. |
| `cooldownMs` | `120000` | How long a throttled or timed-out backend is skipped. `0` disables. |
| `maxResults` | `8` | Source cap when the caller names none. |
| `snippetChars` | `600` | Characters kept per snippet. `0` keeps the endpoint's text whole. |
| `maxBytes` | `2097152` | Hard cap on a response body, in bytes. |

Example profile patch:

```yaml
- id: keyless-search
  config:
    order: [exa, parallel]
    timeoutMs: 6000
    snippetChars: 400
```

## Failure behaviour

| Situation | Result |
|---|---|
| Backend throttles (200 + flag) | Parked for `cooldownMs`, next backend tried |
| Backend times out | Parked for `cooldownMs`, next backend tried |
| Backend returns 403 / bot wall | Parked for `cooldownMs`, next backend tried |
| Backend returns no usable rows | Next backend tried, not parked |
| Backend returns 400 | Aborts the chain: the request is malformed |
| Caller cancels | Aborts the chain: never a backend fault |
| All backends fail | One error naming every backend and its failure class |

When every backend is parked, `available()` returns `false`, so dsh reports the
provider as unavailable rather than failing each search individually.

## Known limits

- **Free tiers have no SLA.** The limits are undocumented and can change
  without notice. Cooldowns and the fallback order are the mitigation, not a
  guarantee.
- **Queries leave your machine** for the configured endpoints, the same as any
  hosted search API. Check your own data-handling requirements.
- **The endpoints are third-party services.** Whether your use of them is
  acceptable is between you and them; read their terms. This plugin only
  speaks the public MCP protocol they expose.
- **Two backends only.** Other keyless-sounding search APIs require a key and
  return 401 without one, so they are not backends here.

## Design notes

- dsh selects exactly one provider per capability (`WEB_PROVIDER_AMBIGUOUS` when
  several are usable and none is configured), so the chain lives inside one
  provider rather than in several registrations.
- Errors are routed on a stable `code`, never on message text.
- Response bodies are read under a byte cap before parsing.
- Tests never touch the network: `fetch` is injected, and the fixtures mirror
  real endpoint payloads.

## Development

```bash
npm install
npm run check   # typecheck + tests + lint
npm run build
```

## License

MIT