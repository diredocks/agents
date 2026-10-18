/**
 * Persistent input history.
 *
 * - Records every interactive prompt in ~/.pi/agent/history.json
 * - Seeds the input editor's history at startup, so ↑/↓ also reaches prompts
 *   from previous sessions
 * - Ctrl+R enters an inline search: type to filter, ↑/↓ to move,
 *   Ctrl+R for the next match, Enter to insert the entry, Esc to cancel.
 *   The matches are shown below the input, just like the `/` command menu.
 * - `/history` opens the search, `/history clear` empties the file
 *
 * The editor is wrapped rather than replaced: if another extension has
 * already installed a custom editor (for example better-footer.ts), that
 * editor is reused and only its history is seeded.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorComponent,
	type EditorTheme,
	fuzzyFilter,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const HISTORY_FILE = join(getAgentDir(), "history.json");
const HISTORY_WIDGET = "input-history";
const MAX_HISTORY = 500;
const MAX_RESULTS = 8;

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

interface SearchState {
	active: boolean;
	draft: string;
	items: string[];
	filtered: string[];
	selected: number;
}

function loadHistory(): string[] {
	try {
		if (!existsSync(HISTORY_FILE)) return [];
		const parsed: unknown = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	} catch {
		return [];
	}
}

function saveHistory(history: string[]): void {
	try {
		mkdirSync(dirname(HISTORY_FILE), { recursive: true });
		const temporary = `${HISTORY_FILE}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, "utf8");
		renameSync(temporary, HISTORY_FILE);
	} catch {
		// Persistence is best effort and must never break input handling.
	}
}

function remember(text: string): void {
	const entry = text.trim();
	if (!entry) return;

	const history = loadHistory();
	const existing = history.indexOf(entry);
	if (existing !== -1) history.splice(existing, 1);
	history.unshift(entry);
	if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
	saveHistory(history);
}

function singleLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ⏎ ");
}

/**
 * Display-only list shown below the editor while searching, mirroring the
 * `/` command autocomplete.
 */
class HistoryWidget implements Component {
	constructor(
		private readonly state: SearchState,
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const { filtered, selected } = this.state;
		const lines: string[] = [];

		if (filtered.length === 0) {
			lines.push(this.theme.fg("warning", truncateToWidth("  no matching history", width, "")));
		} else {
			const count = Math.min(MAX_RESULTS, filtered.length);
			const start = Math.min(
				Math.max(0, selected - Math.floor(count / 2)),
				Math.max(0, filtered.length - count),
			);

			for (let index = start; index < start + count; index++) {
				const item = filtered[index];
				if (item === undefined) continue;

				const isSelected = index === selected;
				const text = `${isSelected ? "❯ " : "  "}${singleLine(item)}`;
				lines.push(
					isSelected
						? this.theme.fg("accent", truncateToWidth(text, width, "…"))
						: this.theme.fg("muted", truncateToWidth(text, width, "…")),
				);
			}
		}

		const position = filtered.length > 0 ? ` (${selected + 1}/${filtered.length})` : "";
		lines.push(this.theme.fg("dim", truncateToWidth(`  history${position}`, width, "")));

		return lines;
	}
}

/**
 * Wrap an editor instance with persistent history plus the inline Ctrl+R
 * search mode. Returns a function that starts the search, for `/history`.
 */
function attachHistory(editor: EditorComponent, ctx: ExtensionContext, tui: TUI): () => void {
	// Seed the editor's own ↑/↓ history. addToHistory prepends, so feed the
	// oldest persisted entries first and leave the newest on top.
	const addToHistory = editor.addToHistory?.bind(editor);
	if (addToHistory) {
		for (const entry of [...loadHistory()].reverse()) addToHistory(entry);
	}

	const state: SearchState = { active: false, draft: "", items: [], filtered: [], selected: 0 };
	let widgetShown = false;

	const showWidget = (): void => {
		if (widgetShown) return;
		widgetShown = true;
		ctx.ui.setWidget(HISTORY_WIDGET, (_tui, theme) => new HistoryWidget(state, theme), {
			placement: "belowEditor",
		});
	};

	const hideWidget = (): void => {
		if (!widgetShown) return;
		widgetShown = false;
		ctx.ui.setWidget(HISTORY_WIDGET, undefined);
	};

	const refilter = (): void => {
		const query = editor.getText().trim();
		state.filtered = query ? fuzzyFilter(state.items, query, (item) => item) : state.items;
		state.selected = 0;
	};

	const move = (delta: number): void => {
		if (state.filtered.length === 0) return;
		state.selected = (state.selected + delta + state.filtered.length) % state.filtered.length;
		tui.requestRender();
	};

	const start = (): void => {
		if (state.active) return;
		const items = loadHistory();
		if (items.length === 0) return;

		state.active = true;
		state.draft = editor.getText();
		state.items = items;
		state.filtered = items;
		state.selected = 0;
		editor.setText("");
		showWidget();
		tui.requestRender();
	};

	const stop = (accept: boolean): void => {
		if (!state.active) return;

		state.active = false;
		hideWidget();

		const value = accept ? state.filtered[state.selected] : undefined;
		editor.setText(value ?? state.draft);
		state.draft = "";
		tui.requestRender();
	};

	const baseHandleInput = editor.handleInput.bind(editor);
	editor.handleInput = (data: string): void => {
		if (!state.active) {
			if (matchesKey(data, "ctrl+r")) {
				start();
				return;
			}
			baseHandleInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			stop(false);
			return;
		}
		if (matchesKey(data, "enter")) {
			stop(true);
			return;
		}
		if (matchesKey(data, "up")) return move(-1);
		if (matchesKey(data, "down")) return move(1);
		if (matchesKey(data, "pageUp")) return move(-MAX_RESULTS);
		if (matchesKey(data, "pageDown")) return move(MAX_RESULTS);
		if (matchesKey(data, "ctrl+r")) return move(1);

		baseHandleInput(data);
		refilter();
		tui.requestRender();
	};

	return start;
}

export default function inputHistoryExtension(pi: ExtensionAPI) {
	let installTimer: ReturnType<typeof setTimeout> | undefined;
	let installedFactory: EditorFactory | undefined;
	let baseFactory: EditorFactory | undefined;
	let startSearch: (() => void) | undefined;

	// Persisting through the input event works with any editor component,
	// including the default one and editors installed by other extensions.
	pi.on("input", (event) => {
		if (event.source === "interactive") remember(event.text);
	});

	pi.registerCommand("history", {
		description: "Search input history, or clear it with /history clear",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/history requires interactive mode", "error");
				return;
			}
			if (args.trim().toLowerCase() === "clear") {
				saveHistory([]);
				ctx.ui.notify("Input history cleared", "info");
				return;
			}
			if (startSearch) {
				startSearch();
			} else {
				ctx.ui.notify("No input history yet", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		if (installTimer) clearTimeout(installTimer);
		// Let other extensions install their editor first, then wrap the final
		// factory so their behavior is preserved.
		installTimer = setTimeout(() => {
			installTimer = undefined;

			const previous = ctx.ui.getEditorComponent();
			if (previous !== undefined && previous === installedFactory) return;

			baseFactory = previous;
			const factory: EditorFactory = (tui, theme, keybindings) => {
				const editor = baseFactory
					? baseFactory(tui, theme, keybindings)
					: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				startSearch = attachHistory(editor, ctx, tui);
				return editor;
			};

			installedFactory = factory;
			ctx.ui.setEditorComponent(factory);
		}, 0);
	});

	pi.on("session_shutdown", () => {
		if (installTimer) {
			clearTimeout(installTimer);
			installTimer = undefined;
		}
		startSearch = undefined;
	});
}
