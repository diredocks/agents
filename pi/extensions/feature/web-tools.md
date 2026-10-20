# Web tools

Pi does not ship web tools. Two extensions in this folder add them, modelled on
OpenCode's implementations.

| File | What it provides |
| --- | --- |
| `webfetch.ts` | The local `webfetch` tool. |
| `websearch.ts` | Exa or Parallel search and provider-side fetching, through pi's built-in MCP support. |

## `webfetch`

`webfetch(url, format?, timeout?)` fetches any HTTP/HTTPS URL locally.

- Per-format `Accept` headers with q-value fallbacks and a Chrome user agent.
- Retries with an honest `pi/<version>` user agent when Cloudflare answers a 403
  `cf-mitigated: challenge`, because the browser UA no longer matches this
  client's TLS fingerprint.
- 5 MB response cap, 30 second default timeout, 120 second ceiling, cancellable
  with the tool's abort signal.
- HTML is converted locally to Markdown (default), plain text, or returned as raw
  HTML: headings, lists, links and images resolved against the URL, fenced code
  blocks, quotes, and simple tables. Scripts, styles, `iframe`, `svg`, and
  similar are dropped.
- Images come back as image content; SVG is treated as text; non-textual MIME
  types are rejected.
- Model-facing output stays inside pi's truncation budget (2000 lines / 50 KB).
  The complete text is written to `/tmp/pi/web/webfetch-<hash>.md` and that path
  is reported in the result.

## `websearch`

The extension picks one provider and registers it as an MCP server with `direct`
exposure, so the model calls that server's own tools:

| Provider | Tools |
| --- | --- |
| Exa | `mcp__exa__web_search_exa`, `mcp__exa__web_fetch_exa` |
| Parallel | `mcp__parallel__web_search`, `mcp__parallel__web_fetch` |

Pi owns the MCP protocol — initialize handshake, SSE replies, retries on
408/429/5xx, reconnects — so tool schemas and descriptions stay current with what
the server actually accepts instead of drifting with a hand-written client.
Results over 20 KB are middle-truncated by pi and saved to a temporary file.

Exa's `web_fetch_exa` and Parallel's `web_fetch` crawl server-side, which covers
JavaScript-rendered and bot-protected pages that the local `webfetch` cannot
read. `webfetch` still matters for `localhost`, private URLs, and anything that
should not be sent to a third party.

Because the tools belong to an MCP server, `--tools`/`--exclude-tools` patterns
are `mcp__exa__*` / `mcp__parallel__*`, not `websearch`.

## Provider selection

No settings are involved.

| Variable | Effect |
| --- | --- |
| `PARALLEL_API_KEY` | Switches search to Parallel and is sent as a bearer token. |
| `EXA_API_KEY` | Sent to Exa as `?exaApiKey=…`; without it Exa's public MCP endpoint is used. |
| `PI_WEBSEARCH_PROVIDER` | Forces `exa` or `parallel` (handy for testing one provider). |

Run `/mcp` to inspect the connection, tool list, and exposure.
