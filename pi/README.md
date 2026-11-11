# pi extensions

100% vibe coded, no review. USE AT YOUR OWN RISK.

## Layout

| Path | Contents |
| --- | --- |
| `extensions/index.ts` | Entry point. Imports every factory and calls it in order; the folders below have no `index.ts`, so pi loads only this file. |
| `extensions/shell/` | Terminal chrome and input: footer, prompt editor, history, aliases, indicators. |
| `extensions/feature/` | Commands, events, behavior: branching, notifications, elapsed time, web tools. |
| `extensions/renderer/` | Transcript and tool rendering: minimal mode, spinner, turn collapse, compact rows. |
| `lib/` | Shared helpers: HTML→Markdown, tool output bounding, TUI tree access. |
| `backup/` | Read-only snapshots of my global pi config. Ignore. |

## Add an extension

1. Create it in `extensions/{shell,feature,renderer}/`.
2. Export a default factory: `export default function (pi: ExtensionAPI) { ... }`.
3. Register it in `extensions/index.ts` (import + call, keeping load order).
4. `npm run typecheck` must pass.

## Development

```sh
npm install                                     # @earendil-works/pi-* types
npm run typecheck                               # tsc --noEmit
pi -e ./extensions/index.ts                     # load everything
pi -e ./extensions/shell/working-elapsed.ts     # load one extension
```

The `@earendil-works/pi-*` packages are types only; pi provides the runtime
modules. This workspace is the single source of truth and is already registered
with `pi install ~/Code/project/agents/pi`, so there is no copy under
`~/.pi/agent/` — run `/reload` in pi after changing an extension.

## Reference

| Need | Location |
| --- | --- |
| Extension API types | `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` |
| TUI types (`Component`, `TUI`, …) | `node_modules/@earendil-works/pi-tui/dist/index.d.ts` |
| Message / model types | `node_modules/@earendil-works/pi-ai/dist/index.d.ts` |
| Extension guide | `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` |
| Example extensions | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/` |

Web tools (local `webfetch`, Exa/Parallel MCP search):
[`extensions/feature/web-tools.md`](./extensions/feature/web-tools.md).
