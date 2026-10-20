# pi extensions

Personal pi extensions, 100% vibe coded without review. USE AT YOUR OWN RISK!

## Layout

| Path | What goes there |
| --- | --- |
| `extensions/index.ts` | Single entry point; imports every extension factory and calls it in order. Pi loads this file (and ignores the category folders, which have no `index.ts`). |
| `extensions/shell/` | Terminal chrome and input: footer, prompt editor, history, aliases, working indicator. |
| `extensions/feature/` | Commands, events, and behavior: session branching, notifications, elapsed time, prompt jump. |
| `extensions/renderer/` | Transcript/tool rendering: minimal mode, thinking spinner, turn collapse, compact ask/todo rows. |
| `lib/` | Shared helpers used by the extensions. |

## Adding an extension

1. Put the file in the matching folder (`shell/`, `feature/`, `renderer/`).
2. Export a default factory: `export default function (pi: ExtensionAPI) { ... }`.
3. Register it in `extensions/index.ts` (import + call, keeping load order).
4. `npm run typecheck` must pass.

## Development

```sh
npm install        # installs the @earendil-works/pi-* type declarations
npm run typecheck  # tsc --noEmit
```

The `@earendil-works/pi-*` packages are only needed for types; at runtime pi
provides those modules itself.

```sh
pi -e ./extensions/shell/working-elapsed.ts   # try a single extension
pi -e ./extensions/index.ts                    # load everything
pi install ~/Code/project/agents/pi            # register this workspace (done)
```

This workspace is the single source of truth. Pi loads it as a local package, so
there is no copy under `~/.pi/agent/extensions/` or `~/.pi/agent/lib/`; run
`/reload` in pi after changing an extension.

## Where things are

| Need | Location |
| --- | --- |
| Extension API types | `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` (re-exports `dist/core/extensions/*.d.ts`) |
| TUI types (`Component`, `TUI`, ...) | `node_modules/@earendil-works/pi-tui/dist/index.d.ts` |
| Message / model types | `node_modules/@earendil-works/pi-ai/dist/index.d.ts` |
| Extension guide | `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` |
| Example extensions | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/` |
