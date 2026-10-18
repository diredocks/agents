/**
 * Pinned prompt navigation.
 *
 * Adds a small arrow button to the right end of the input box's top border:
 *
 *   ──────────────────────────────────────────────────────────── ↑
 *    > _
 *   ──────────────────────────────────────────────────────────────
 *
 * Clicking it scrolls the transcript to the previous user message:
 * - From the bottom of the transcript (the usual case), the first click goes
 *   to the most recent user message A.
 * - Clicking again, now that the viewport sits on A, goes to the user message
 *   before it, B, and so on, until the earliest user message is reached.
 *
 * Implementation notes:
 * - The button is drawn by wrapping the *current* editor's
 *   `renderTopBorder`; it therefore cooperates with other extensions that
 *   replace the editor (for example better-footer) instead of replacing it.
 * - A zero-height widget above/below the editor is used only to capture the
 *   `TUI` so the button can reach the transcript scroll view.
 * - Mouse clicks reach the app in fullscreen mode (the default). In regular
 *   mode the button is decorative, because the terminal owns scrollback.
 *
 * Display-only: nothing here affects the session or the LLM context.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	sliceByColumn,
	visibleWidth,
} from "@earendil-works/pi-tui";

const CAPTURE_WIDGET_KEY = "pinned-prompt";
const BUTTON_TEXT = " ^ ";
const BUTTON_WIDTH = visibleWidth(BUTTON_TEXT);

/** Global markers so re-loading the extension reuses (not stacks) its patches. */
const PATCH_STATE = Symbol.for("@pinned-prompt/patch-state");

interface PatchState {
	theme: Theme;
	isVisible: () => boolean;
	onJump: () => void;
}

interface PatchableEditor extends Component {
	children?: Component[];
	renderTopBorder?(width: number, hiddenLineCount: number): string;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

interface ScrollableComponent extends Component {
	children: Component[];
	readonly scrollTop: number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
	getContentWidth(width: number): number;
}

/** A user message renders as a Container that carries the raw message text. */
function isUserMessageComponent(node: unknown): node is { children: Component[] } {
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

/** Start rows of every user message in the rendered transcript. */
function collectUserMessageRows(root: unknown, width: number): number[] {
	const rows: number[] = [];

	const walk = (node: unknown, baseRow: number): void => {
		if (isUserMessageComponent(node)) rows.push(baseRow);

		const children = (node as { children?: unknown } | undefined)?.children;
		if (!Array.isArray(children)) return;

		let row = baseRow;
		for (const child of children) {
			walk(child, row);
			row += safeRenderHeight(child, width);
		}
	};

	walk(root, 0);
	return rows;
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

/** First focusable text editor in the component tree. */
function findEditor(node: unknown): PatchableEditor | undefined {
	if (!node || typeof node !== "object") return undefined;
	const candidate = node as PatchableEditor & { handleInput?: unknown; setText?: unknown };
	if (
		typeof candidate.handleInput === "function" &&
		typeof candidate.setText === "function" &&
		typeof candidate.render === "function" &&
		typeof candidate.handleMouse === "function"
	) {
		return candidate;
	}
	const children = (node as { children?: unknown }).children;
	if (Array.isArray(children)) {
		for (const child of children) {
			const found = findEditor(child);
			if (found) return found;
		}
	}
	return undefined;
}

/** Scroll to the user message just above the current viewport top. */
function jumpToPreviousUserMessage(ctx: ExtensionContext, tui: TUI | undefined): void {
	if (!tui || tui.mode !== "fullscreen") {
		ctx.ui.notify("Jumping between messages needs fullscreen mode (the default)", "info");
		return;
	}

	const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
	const scroll = findScrollView(root);
	const document = scroll?.children[0];
	if (!scroll || !document) {
		ctx.ui.notify("Could not find the transcript view", "warning");
		return;
	}

	const width = scroll.getContentWidth(tui.terminal.columns);
	const rows = collectUserMessageRows(document, width).filter((row) => row < scroll.scrollTop);
	const target = rows.at(-1);
	if (target === undefined) {
		ctx.ui.notify("No earlier user message to jump to", "info");
		return;
	}

	scroll.scrollTo(target, { disableFollow: true });
	tui.requestRender();
}

/** Draw the button at the right end of the editor's top border and handle its click. */
function installButtonPatch(
	editor: PatchableEditor,
	theme: Theme,
	isVisible: () => boolean,
	onJump: () => void,
): void {
	const store = editor as unknown as Record<symbol, PatchState | undefined>;
	const existing = store[PATCH_STATE];
	if (existing) {
		// Reloaded extension code: refresh the callbacks without adding another patch.
		existing.theme = theme;
		existing.isVisible = isVisible;
		existing.onJump = onJump;
		return;
	}

	const originalTop = editor.renderTopBorder?.bind(editor);
	if (typeof originalTop !== "function") return;

	store[PATCH_STATE] = { theme, isVisible, onJump };

	editor.renderTopBorder = (width, hiddenLineCount) => {
		const base = originalTop(width, hiddenLineCount);
		const state = store[PATCH_STATE];
		if (!state || !state.isVisible() || width <= BUTTON_WIDTH + 4) return base;
		const left = sliceByColumn(base, 0, width - BUTTON_WIDTH, true);
		const button = state.theme.fg("accent", BUTTON_TEXT);
		return left + button;
	};

	const originalMouse = editor.handleMouse?.bind(editor);
	editor.handleMouse = (event) => {
		const state = store[PATCH_STATE];
		if (state?.isVisible() && event.type === "click" && event.button === "left") {
			if (event.y === 0 && event.x >= event.width - BUTTON_WIDTH) {
				state.onJump();
				return { handled: true, focus: true };
			}
		}
		return originalMouse?.(event);
	};
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let currentCtx: ExtensionContext | undefined;
	let hasUserMessages = false;
	let installTimer: ReturnType<typeof setTimeout> | undefined;

	const refreshHasUserMessages = (ctx: ExtensionContext): void => {
		const next = ctx.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && entry.message.role === "user");
		if (next === hasUserMessages) return;
		hasUserMessages = next;
		tui?.requestRender();
	};

	const onJump = (): void => {
		if (currentCtx) jumpToPreviousUserMessage(currentCtx, tui);
	};

	/**
	 * Install the button on whichever editor is active right now.
	 *
	 * Other extensions may replace or wrap the editor, sometimes asynchronously
	 * (input-history re-creates it in a `setTimeout`), so this is re-run on
	 * session events and after a tick rather than only once at startup. The
	 * per-instance patch state keeps repeated calls from stacking.
	 */
	const applyButtonPatch = (): void => {
		if (!tui || !currentCtx) return;
		const editor = findEditor(tui);
		if (editor) installButtonPatch(editor, currentCtx.ui.theme, () => hasUserMessages, onJump);
	};

	const scheduleButtonPatch = (): void => {
		if (installTimer) clearTimeout(installTimer);
		// Run after other extensions that defer their editor setup (input-history).
		installTimer = setTimeout(() => {
			installTimer = undefined;
			applyButtonPatch();
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		refreshHasUserMessages(ctx);
		if (ctx.mode !== "tui") return;

		// Zero-height capture widget: gives us the TUI so we can reach the editor.
		const capture: Component & { dispose?(): void } = { render: () => [], invalidate() {} };
		ctx.ui.setWidget(CAPTURE_WIDGET_KEY, (nextTui) => {
			tui = nextTui;
			return capture;
		}, { placement: "belowEditor" });

		applyButtonPatch();
		scheduleButtonPatch();
	});

	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		refreshHasUserMessages(ctx);
		applyButtonPatch();
	});

	pi.on("session_compact", (_event, ctx) => {
		currentCtx = ctx;
		refreshHasUserMessages(ctx);
		applyButtonPatch();
	});

	pi.on("message_end", (event, ctx) => {
		currentCtx = ctx;
		if (event.message.role === "user" && !hasUserMessages) {
			hasUserMessages = true;
			tui?.requestRender();
		}
		applyButtonPatch();
	});

	pi.on("session_shutdown", () => {
		if (installTimer) {
			clearTimeout(installTimer);
			installTimer = undefined;
		}
	});
}
