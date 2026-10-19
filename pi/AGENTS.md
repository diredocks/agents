# pi/ — personal pi extensions

Development workspace for the extensions under `extensions/`. The runtime API
types and docs come from the installed `@earendil-works/pi-*` packages, so there
is no need to hunt through the pi binary.

## Where things are

| Need | Location |
| --- | --- |
| Extension API types | `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts` (re-exports `dist/core/extensions/*.d.ts`) |
| TUI types (`Component`, `TUI`, ...) | `node_modules/@earendil-works/pi-tui/dist/index.d.ts` |
| Message / model types | `node_modules/@earendil-works/pi-ai/dist/index.d.ts` |
| Extension guide | `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` |
| Example extensions | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/` |
| This repo's extensions | `extensions/shell/`, `extensions/feature/`, `extensions/renderer/` |
| Shared helpers | `lib/` (imported as `../../lib/...` from a category folder) |

## Adding an extension

1. Put the file in the matching folder: `shell/` (chrome/input), `feature/`
   (commands/events/behavior), `renderer/` (transcript/tool rendering).
2. Export a default factory: `export default function (pi: ExtensionAPI) { ... }`.
3. Register it in `extensions/index.ts` (import + call, keeping load order).
4. `npm run typecheck` must pass.

`node_modules` is only for types; at runtime pi provides the `@earendil-works/*`
modules itself.

This workspace is registered with pi as a local package
(`pi install ~/Code/project/agents/pi`), so pi loads it directly. There is no
copy under `~/.pi/agent/extensions/` or `~/.pi/agent/lib/`; run `/reload` in pi
after changing an extension.

## Commands

```sh
npm install
npm run typecheck
pi -e ./extensions/shell/working-elapsed.ts   # try a single extension
pi -e ./extensions/index.ts                    # load everything
pi install ~/Code/project/agents/pi            # register this workspace (done)
```
