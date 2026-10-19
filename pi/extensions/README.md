# pi extensions

Personal pi extensions. These are 100% vibe coded without any review, USE AT YOUR OWN RISK!

## Layout

| Path | What goes there |
| --- | --- |
| `index.ts` | Single entry point; imports every extension factory and calls it in order. Pi loads this file (and ignores the category folders, which have no `index.ts`). |
| `shell/` | Terminal chrome and input: footer, prompt editor, history, aliases, working indicator. |
| `feature/` | Commands, events, and behavior: session branching, notifications, elapsed time, prompt jump. |
| `renderer/` | Transcript/tool rendering: minimal mode, thinking spinner, turn collapse. |
| `../lib/` | Shared helpers imported by extensions (`../../lib/...` from a category folder). |

## Development

```sh
npm install        # installs the @earendil-works/pi-* type declarations
npm run typecheck  # tsc --noEmit
```

The `@earendil-works/pi-*` packages are only needed for types; at runtime pi
provides those modules itself.

To try a single extension: `pi -e ./shell/working-elapsed.ts`.
To load everything: `pi -e ./index.ts`, or copy this folder to
`~/.pi/agent/extensions/` (together with `../lib/`) and run `/reload`.
