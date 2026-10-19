/**
 * One-line todo tool rows.
 *
 * `rpiv-todo` draws every `todo` call as two transcript rows: the call itself
 * (`todo → Create FooRepository`) and a status echo on the next row
 * (`◐ in progress`, `● completed`, `✓`). The status is worth keeping, the
 * second row is not, so this extension moves the echo onto the call line:
 *
 *   todo → Create FooRepository  ◐ in progress
 *
 * It overrides only the `todo` renderers through `pi.registerToolRenderer`, and
 * reuses the plugin's own `renderCall`/`renderResult` output instead of
 * re-implementing it, so subject lookup, glyph/colour vocabulary, and the
 * locale-aware status labels stay identical to the original. The result
 * renderer stashes the rendered echo in the shared renderer state, returns a
 * zero-height component (a `Text("")` renders no rows, so the row that the
 * status used to occupy disappears), and asks for one redraw so the call
 * renderer can pick the echo up.
 *
 * Display-only: nothing here affects the tool, the session, or the LLM context.
 */

import type {
	ExtensionAPI,
	Theme,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

/** Signatures the resolver has to produce, taken from the public renderer type. */
type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type CallArgs = Parameters<CallRenderer>[0];
type RenderContext = Parameters<CallRenderer>[2];
type Result = Parameters<ResultRenderer>[0];
type ResultOptions = Parameters<ResultRenderer>[1];

/** Tool name owned by `@juicesharp/rpiv-todo`. */
const TOOL_NAME = "todo";

/** Renderer-state key holding the already-themed status echo. */
const SUFFIX_KEY = "rpivTodoRowSuffix";

/** Drop control characters so a subject cannot inject escapes into the row. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function sanitize(text: string): string {
	return text.replace(CONTROL_CHARS, " ");
}

/** Read a rendered component back as its (still themed) text. */
function renderedText(component: Component | undefined): string {
	if (!component) return "";
	const withText = component as { text?: unknown };
	if (typeof withText.text === "string") return withText.text;
	try {
		return component.render(1000).join("\n");
	} catch {
		return "";
	}
}

/** Call line used only if the plugin's own renderer is unavailable. */
function fallbackCall(rawArgs: unknown, theme: Theme): string {
	const args = (rawArgs ?? {}) as Record<string, unknown>;
	const action = typeof args.action === "string" ? args.action : "?";
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
	if (typeof args.subject === "string" && args.subject) {
		text += ` ${theme.fg("dim", sanitize(args.subject))}`;
	} else if (typeof args.id === "number") {
		text += ` ${theme.fg("accent", `#${args.id}`)}`;
	}
	return text;
}

export default function (pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== TOOL_NAME) return next();

		// What the remaining resolvers (then the registered tool) would draw.
		const base: ToolRenderers | undefined = next();

		function renderCall(args: CallArgs, theme: Theme, context: RenderContext): Component {
			const line = base?.renderCall ? renderedText(base.renderCall(args, theme, context)) : fallbackCall(args, theme);
			const suffix = typeof context.state[SUFFIX_KEY] === "string" ? (context.state[SUFFIX_KEY] as string) : "";
			return new Text(`${line}${suffix}`, 0, 0);
		}

		function renderResult(result: Result, options: ResultOptions, theme: Theme, context: RenderContext): Component {
			const echo = base?.renderResult ? renderedText(base.renderResult(result, options, theme, context)) : "";
			const suffix = echo.trim().length > 0 ? `  ${echo}` : "";
			if (context.state[SUFFIX_KEY] !== suffix) {
				context.state[SUFFIX_KEY] = suffix;
				// One redraw so renderCall can pick the echo up; the guard above
				// makes the re-entrant pass a no-op.
				context.invalidate();
			}
			return new Text("", 0, 0);
		}

		return { ...(base ?? {}), renderCall, renderResult };
	});
}
