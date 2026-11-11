# Web tools

Pi ships no web tools; two extensions here add them, modelled on OpenCode's.

| File | Provides |
| --- | --- |
| `webfetch.ts` | Local `webfetch(url, format?, timeout?)`, `markdown` or `html`. |
| `websearch.ts` | Exa and Parallel search/fetch via MCP. |

`webfetch`: 5 MB cap, 30 s default / 120 s max, HTML → Markdown via the
`html2markdown` CLI, Cloudflare 403 retried with a `pi/<version>` UA, full output
saved to `/tmp/pi/web/webfetch-<hash>.md`.

`websearch` registers `mcp__exa__web_search_exa`, `mcp__exa__web_fetch_exa`,
`mcp__parallel__web_search`, `mcp__parallel__web_fetch`. The provider fetches
crawl server-side, so use them for JS-rendered or bot-protected pages; use local
`webfetch` for `localhost`, private, or sensitive URLs. Pi handles the MCP
protocol, and results over 20 KB are truncated and saved to a temp file.

`PARALLEL_API_KEY` is a bearer token; `EXA_API_KEY` is optional (falls back to
Exa's public endpoint). `/mcp` lists connections and tools.
