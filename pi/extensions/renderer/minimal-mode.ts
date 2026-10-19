/**
 * Minimal Mode Example - Demonstrates a "minimal" tool display mode
 *
 * This extension overrides built-in tools to provide custom rendering:
 * - Collapsed mode: Only shows the tool call (command/path), no output
 * - Expanded mode: Shows full output like the built-in renderers
 *
 * This demonstrates how a "minimal mode" could work, where ctrl+o cycles through:
 * - Standard: Shows truncated output (current default)
 * - Expanded: Shows full output (current expanded)
 * - Minimal: Shows only tool call, no output (this extension's collapsed mode)
 *
 * Usage:
 *   pi -e ./minimal-mode.ts
 *
 * Then use ctrl+o to toggle between minimal (collapsed) and full (expanded) views.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatReadLineRange,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function createBuiltInTools(cwd: string) {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

interface ToolResultLike {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
}

interface RenderOptionsLike {
	expanded?: boolean;
	isPartial?: boolean;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Text content of a tool result, or an empty string. */
function resultText(result: ToolResultLike): string {
	const part = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string");
	return part?.text ?? "";
}

function isErrorResult(result: ToolResultLike): boolean {
	return result.isError === true;
}

/** Built-in "No files found" / "No matches found" style messages. */
function isNoResult(text: string): boolean {
	return /^\s*no\b.*\b(found|matches|files|entries|results)\b/i.test(text);
}

function countNonEmptyLines(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

/** Show a compact error even when minimal mode hides normal output. */
function renderError(result: ToolResultLike, theme: ThemeLike): Text {
	const lines = resultText(result)
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, 3);
	const body = lines.length > 0 ? lines : ["Error"];
	return new Text(`\n${body.map((line) => theme.fg("error", line)).join("\n")}`, 0, 0);
}

/** Delegate expanded rendering to the built-in tool, falling back to plain text. */
function renderExpanded(
	base: { renderResult?: (...args: any[]) => Component | null | undefined },
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: unknown,
): Component {
	const rendered = base.renderResult?.(result, options, theme, context);
	if (rendered !== undefined && rendered !== null) return rendered;

	const text = resultText(result).trim();
	if (!text) return new Text("", 0, 0);
	return new Text(`\n${text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n")}`, 0, 0);
}

export default function (pi: ExtensionAPI) {
	const tools = createBuiltInTools(process.cwd());

	// =========================================================================
	// Read Tool
	// =========================================================================
	pi.registerTool({
		...tools.read,

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			const lineRange = formatReadLineRange(args.offset, args.limit);
			if (lineRange) {
				pathDisplay += theme.fg("warning", lineRange);
			}

			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) return new Text("", 0, 0);
			return renderExpanded(tools.read, result, options, theme, context);
		},
	});

	// =========================================================================
	// Bash Tool
	// =========================================================================
	pi.registerTool({
		...tools.bash,

		renderCall(args, theme, _context) {
			const command = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

			return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) return new Text("", 0, 0);
			return renderExpanded(tools.bash, result, options, theme, context);
		},
	});

	// =========================================================================
	// Write Tool
	// =========================================================================
	pi.registerTool({
		...tools.write,

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";

			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) return new Text("", 0, 0);
			return renderExpanded(tools.write, result, options, theme, context);
		},
	});

	// =========================================================================
	// Edit Tool
	// =========================================================================
	pi.registerTool({
		...tools.edit,
		renderShell: "default",

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) return new Text("", 0, 0);
			return renderExpanded(tools.edit, result, options, theme, context);
		},
	});

	// =========================================================================
	// Find Tool
	// =========================================================================
	pi.registerTool({
		...tools.find,

		renderCall(args, theme, _context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) {
				const text = resultText(result);
				if (!text.trim() || isNoResult(text)) return new Text("", 0, 0);
				const count = countNonEmptyLines(text);
				return count > 0 ? new Text(theme.fg("muted", ` → ${count} files`), 0, 0) : new Text("", 0, 0);
			}
			return renderExpanded(tools.find, result, options, theme, context);
		},
	});

	// =========================================================================
	// Grep Tool
	// =========================================================================
	pi.registerTool({
		...tools.grep,

		renderCall(args, theme, _context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const glob = args.glob;
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) {
				const text = resultText(result);
				if (!text.trim() || isNoResult(text)) return new Text("", 0, 0);
				const count = countNonEmptyLines(text);
				return count > 0 ? new Text(theme.fg("muted", ` → ${count} matches`), 0, 0) : new Text("", 0, 0);
			}
			return renderExpanded(tools.grep, result, options, theme, context);
		},
	});

	// =========================================================================
	// Ls Tool
	// =========================================================================
	pi.registerTool({
		...tools.ls,

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (isErrorResult(result)) return renderError(result, theme);
			if (!options.expanded) {
				const text = resultText(result);
				if (!text.trim() || isNoResult(text)) return new Text("", 0, 0);
				const count = countNonEmptyLines(text);
				return count > 0 ? new Text(theme.fg("muted", ` → ${count} entries`), 0, 0) : new Text("", 0, 0);
			}
			return renderExpanded(tools.ls, result, options, theme, context);
		},
	});
}
