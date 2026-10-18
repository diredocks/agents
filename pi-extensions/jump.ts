/**
 * Jump to a user prompt in the current session.
 *
 * `/jump` opens an inline search below the input, mirroring the
 * input-history interaction:
 *
 *   ┌ input ─────────────────────────────────────────────┐
 *   │ > _                                                │
 *   └────────────────────────────────────────────────────┘
 *     jump: auth
 *     ❯ fix the auth redirect
 *       (1/3)
 *     ↑/↓ move · Enter jump · Esc cancel
 *
 * Type to fuzzy-filter the user prompts of the active branch, ↑/↓ to move,
 * PageUp/PageDown to move faster, Ctrl+R for the next match, Enter to scroll
 * the transcript to that prompt, Esc to cancel.
 *
 * The list is built from the rendered transcript (the same user-message
 * components the transcript draws), so the rows always line up with what is
 * on screen. This works in fullscreen mode (the default); in regular mode the
 * terminal owns the scrollback, so there is nothing for Pi to scroll.
 *
 * Display-only: nothing here affects the session or the LLM context.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	fuzzyFilter,
	isKeyRelease,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "jump-to-prompt";
const MAX_RESULTS = 10;

interface JumpItem {
	/** Start row of the user message in the rendered transcript. */
	row: number;
	/** Raw message text, used for display and fuzzy filtering. */
	text: string;
}

interface JumpState {
	active: boolean;
	query: string;
	/** Newest first, so the most recent prompt is selected by default. */
	items: JumpItem[];
	filtered: JumpItem[];
	selected: number;
}

/* ------------------------------------------------------------------ */
/* Transcript inspection                                               */
/* ------------------------------------------------------------------ */

interface ScrollableComponent extends Component {
	children: Component[];
	readonly scrollTop: number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
	getContentWidth(width: number): number;
}

/** A user message renders as a Container that carries the raw message text. */
function isUserMessageComponent(node: unknown): node is { text: string; children: Component[] } {
	if (!node || typeof node !== "object") return false;
	const candidate = node as { text?: unknown; children?: unknown };
	return typeof candidate.text === "string" && Array.isArray(candidate.children);
}

function safeRenderHeight(node: unknown, width: number): number {
	try {
		const lines = (node as Component).render(width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

/** Start rows of every user message in the rendered transcript, oldest first. */
function collectUserMessages(root: unknown, width: number): JumpItem[] {
	const items: JumpItem[] = [];

	const walk = (node: unknown, baseRow: number): void => {
		if (isUserMessageComponent(node)) items.push({ text: node.text, row: baseRow });

		const children = (node as { children?: unknown } | undefined)?.children;
		if (!Array.isArray(children)) return;

		let row = baseRow;
		for (const child of children) {
			walk(child, row);
			row += safeRenderHeight(child, width);
		}
	};

	walk(root, 0);
	return items;
}

/** First scroll view reachable from the layout root (the transcript). */
function findScrollView(node: unknown): ScrollableComponent | undefined {
	if (!node || typeof node !== "object") return undefined;
	const candidate = node as { children?: unknown; scrollTo?: unknown; getContentWidth?: unknown };
	if (typeof candidate.scrollTo === "function" && typeof candidate.getContentWidth === "function") {
		if (Array.isArray(candidate.children)) return candidate as unknown as ScrollableComponent;
	}
	if (!Array.isArray(candidate.children)) return undefined;
	for (const child of candidate.children) {
		const found = findScrollView(child);
		if (found) return found;
	}
	return undefined;
}

function findTranscript(tui: TUI | undefined): { scroll: ScrollableComponent; document: Component } | undefined {
	if (!tui) return undefined;
	const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
	const scroll = findScrollView(root);
	const document = scroll?.children[0];
	if (!scroll || !document) return undefined;
	return { scroll, document };
}

/** User prompts of the rendered transcript, newest first. */
function collectPrompts(tui: TUI | undefined): JumpItem[] {
	const transcript = findTranscript(tui);
	if (!transcript || !tui) return [];
	const width = transcript.scroll.getContentWidth(tui.terminal.columns);
	return collectUserMessages(transcript.document, width).reverse();
}

/* ------------------------------------------------------------------ */
/* Widget                                                              */
/* ------------------------------------------------------------------ */

function singleLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ⏎ ");
}

class JumpWidget implements Component {
	constructor(
		private readonly state: JumpState,
		private readonly theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.state.active) return [];

		const lines: string[] = [];
		const query = this.state.query.trim();
		lines.push(this.theme.fg("dim", truncateToWidth(query ? `  jump: ${query}` : "  jump to a prompt", width, "…")));

		const { filtered, selected } = this.state;
		if (filtered.length === 0) {
			lines.push(this.theme.fg("warning", truncateToWidth("  no matching prompt", width, "")));
		} else {
			const count = Math.min(MAX_RESULTS, filtered.length);
			const start = Math.min(Math.max(0, selected - Math.floor(count / 2)), Math.max(0, filtered.length - count));

			for (let index = start; index < start + count; index++) {
				const item = filtered[index];
				if (item === undefined) continue;

				const isSelected = index === selected;
				const text = `${isSelected ? "❯ " : "  "}${singleLine(item.text)}`;
				lines.push(
					isSelected
						? this.theme.fg("accent", truncateToWidth(text, width, "…"))
						: this.theme.fg("muted", truncateToWidth(text, width, "…")),
				);
			}
		}

		const position = filtered.length > 0 ? ` (${selected + 1}/${filtered.length})` : "";
		lines.push(this.theme.fg("dim", truncateToWidth(`  ↑/↓ move · Enter jump · Esc cancel${position}`, width, "…")));
		return lines;
	}
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function jumpExtension(pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let unsubscribeInput: (() => void) | undefined;

	const state: JumpState = { active: false, query: "", items: [], filtered: [], selected: 0 };

	const refilter = (): void => {
		const query = state.query.trim();
		state.filtered = query ? fuzzyFilter(state.items, query, (item) => item.text) : state.items;
		state.selected = 0;
	};

	const move = (delta: number): void => {
		if (state.filtered.length === 0) return;
		state.selected = (state.selected + delta + state.filtered.length) % state.filtered.length;
		tui?.requestRender();
	};

	const stop = (): void => {
		if (!state.active) return;
		state.active = false;
		state.query = "";
		state.items = [];
		state.filtered = [];
		state.selected = 0;
		tui?.requestRender();
	};

	const accept = (): void => {
		const item = state.filtered[state.selected];
		stop();
		if (!item) return;
		const transcript = findTranscript(tui);
		if (!transcript) return;
		transcript.scroll.scrollTo(item.row, { disableFollow: true });
		tui?.requestRender();
	};

	const start = (): boolean => {
		if (!tui || tui.mode !== "fullscreen") return false;
		const items = collectPrompts(tui);
		if (items.length === 0) return false;

		state.active = true;
		state.query = "";
		state.items = items;
		state.filtered = items;
		state.selected = 0;
		tui.requestRender();
		return true;
	};

	const handleInput = (data: string): { consume?: boolean } | undefined => {
		if (!state.active) return undefined;

		// Kitty/iTerm-style keyboard protocols report key releases in addition to
		// presses. Terminal-input listeners run before Pi's own release filter, so
		// swallow releases here -- otherwise every arrow key moves the selection
		// twice and only every other item is reachable.
		if (isKeyRelease(data)) return { consume: true };

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			stop();
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			accept();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			move(-1);
			return { consume: true };
		}
		if (matchesKey(data, "down")) {
			move(1);
			return { consume: true };
		}
		if (matchesKey(data, "pageUp")) {
			move(-MAX_RESULTS);
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			move(MAX_RESULTS);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+r")) {
			move(1);
			return { consume: true };
		}
		if (matchesKey(data, "backspace")) {
			state.query = Array.from(state.query).slice(0, -1).join("");
			refilter();
			tui?.requestRender();
			return { consume: true };
		}
		if (data.startsWith("\x1b")) {
			// Unhandled control/escape sequence: swallow it instead of typing it.
			return { consume: true };
		}
		if (data.length > 0) {
			state.query += data.replace(/\s+/g, " ");
			refilter();
			tui?.requestRender();
		}
		return { consume: true };
	};

	pi.registerCommand("jump", {
		description: "Jump the transcript to a previous user prompt",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/jump requires interactive mode", "error");
				return;
			}
			if (!tui || tui.mode !== "fullscreen") {
				ctx.ui.notify("/jump needs fullscreen mode (the default)", "info");
				return;
			}
			if (!start()) {
				ctx.ui.notify("No user prompts to jump to", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Persistent widget: it captures the TUI and renders the list while the
		// search is active, and renders nothing otherwise.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(nextTui, theme) => {
				tui = nextTui;
				return new JumpWidget(state, theme);
			},
			{ placement: "belowEditor" },
		);

		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput(handleInput);
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		tui = undefined;
		state.active = false;
		state.query = "";
		state.items = [];
		state.filtered = [];
		state.selected = 0;
	});
}
