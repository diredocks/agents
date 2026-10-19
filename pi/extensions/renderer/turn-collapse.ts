/**
 * Turn Collapse
 *
 * After a task finishes, hide everything the agent produced between the user's
 * prompt of that turn and the model's final reply: intermediate assistant
 * messages (the ones that only carry tool calls), every tool execution, and the
 * spacing around them. Only the user prompt and the final answer stay visible.
 *
 * Every completed turn in the transcript is collapsed, not just the newest one.
 *
 * The toggle bar
 * --------------
 * A dim hint line sits right under the user prompt of each turn, at the top of
 * the turn it belongs to:
 *
 *   > refactor the parser
 *
 *   ▸ 12 earlier messages hidden · click to expand
 *
 * Clicking the bar toggles the turn. Clicking the final reply toggles it too, so
 * a turn that ends below the viewport can still be collapsed without scrolling.
 *
 * The bar behaves like CSS `position: sticky; top: 0`: while the turn is
 * expanded and its body is scrolled past, the bar is painted over the first row
 * of the transcript viewport (see "Sticky bar" below), so collapsing never
 * requires scrolling back up or down to a specific message.
 *
 * How it works
 * ------------
 * The extension API has no hook for hiding built-in transcript entries, so the
 * extension inspects the live TUI component tree (the same technique as the
 * `jump.ts` and `pinned-prompt.ts` extensions):
 *
 *   1. A zero-height widget captures the `TUI` instance.
 *   2. From `tui.layoutRoot` it locates the transcript `ScrollView`, its
 *      document container, and the chat `Container` that holds the messages.
 *   3. It walks the chat container's direct children to find turns: a user
 *      message component starts a turn, the last assistant component without
 *      tool calls ends it. A turn that a new user message cut short (the agent
 *      never produced a final reply) ends at its last child instead.
 *   4. Components between the two endpoints get their `render()` temporarily
 *      replaced with a zero-line renderer, so they take no space while hidden.
 *   5. The turn's user message gets `render()` patched to append the hint bar,
 *      and the anchor (the final reply, or the turn's last child) gets
 *      `handleMouse()` patched so a click anywhere on it toggles the turn.
 *
 * Sticky bar
 * ----------
 * The chat container's `render()` is replaced by an equivalent loop that also
 * remembers each child's row range. With the scroll view's `scrollTop` (and the
 * rows the document uses above the chat) the extension knows which row the
 * viewport starts on, so it can:
 *
 *   - paint the hint over that row when the viewport sits inside a turn whose
 *     own bar has already scrolled out of view (the sticky state), and
 *   - translate a click on any bar row back to its turn, from the chat's
 *     `handleMouse()`.
 *
 * The pinned bar replaces one content row instead of inserting lines, so the
 * transcript height (and therefore the scroll position) never jumps.
 *
 * This is display-only: nothing here changes the session or the model context.
 *
 * Requires fullscreen mode (the default), because regular mode leaves the
 * scrollback to the terminal and does not expose mouse hit-testing.
 *
 * Usage:
 *   pi --extension ~/.pi/agent/extensions/turn-collapse.ts
 *   /turn-collapse          expand or collapse every completed turn
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	compositeTuiLine,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	findTranscript,
	isAssistantMessageComponent,
	isUserMessageComponent,
	safeRenderHeight,
	type LooseComponent,
	type MessageLike,
} from "../../lib/tui-tree.ts";

const WIDGET_KEY = "turn-collapse";

/** Marks the components that already carry one of the extension's patches. */
const START_SYMBOL = Symbol.for("@turn-collapse/start");
const ANCHOR_SYMBOL = Symbol.for("@turn-collapse/anchor");
const CHAT_SYMBOL = Symbol.for("@turn-collapse/chat");
/** Stores a hidden component's original render function while it is hidden. */
const RENDER_SYMBOL = Symbol.for("@turn-collapse/original-render");

/** The in-flow hint is a blank line plus the label. */
const HINT_LINES = 2;

/**
 * The document container holds the header, the loaded-resources block, and the
 * chat container, in that order. Look only at its direct children so nested
 * components (for example a Markdown block inside a bash execution) can never
 * be mistaken for the chat container.
 */
function findChat(tui: TUI | undefined): LooseComponent | undefined {
	const transcript = findTranscript(tui);
	const children = (transcript?.document as LooseComponent | undefined)?.children;
	if (!Array.isArray(children)) return undefined;

	// Once the transcript has messages, prefer the child that holds them.
	for (const child of children) {
		const grand = (child as LooseComponent).children;
		if (Array.isArray(grand) && grand.some((candidate) => isUserMessageComponent(candidate))) {
			return child as LooseComponent;
		}
	}

	// Empty transcript: the chat container is the last container-like child.
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index] as LooseComponent;
		if (Array.isArray(child.children)) return child;
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface CollapseGroup {
	/** The turn's user message component; it carries the hint bar. */
	start: Component;
	anchor: Component;
	hidden: Component[];
	collapsed: boolean;
}

/** Row range of a turn's hint bar inside the chat container. */
interface BarHit {
	group: CollapseGroup;
	from: number;
	to: number;
}

/**
 * Mutable state stored on a patched component. Kept in a symbol property so a
 * reloaded extension updates the callbacks instead of stacking another patch.
 */
interface StartState {
	group: CollapseGroup;
	getTheme: () => Theme | undefined;
	onToggle: (group: CollapseGroup) => void;
	originalRender: (width: number) => string[];
	originalMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	/** First row of the hint bar, i.e. the height of the message's own render. */
	barStart?: number;
}

interface AnchorState {
	group: CollapseGroup;
	onToggle: (group: CollapseGroup) => void;
}

interface ChatState {
	getGroups: () => CollapseGroup[];
	getTheme: () => Theme | undefined;
	/** First visible row of the chat container, for the current render width. */
	getViewportTop: (width: number) => number | undefined;
	onToggle: (group: CollapseGroup) => void;
	/** Filled in by every render, then used to route clicks. */
	bars: BarHit[];
	pinned?: { group: CollapseGroup; row: number };
}

/* ------------------------------------------------------------------ */
/* Component tree inspection                                           */
/* ------------------------------------------------------------------ */

function hasToolCalls(message: MessageLike | undefined): boolean {
	return Array.isArray(message?.content) && message.content.some((part) => part?.type === "toolCall");
}

/* ------------------------------------------------------------------ */
/* The hint bar                                                        */
/* ------------------------------------------------------------------ */

function barLabel(group: CollapseGroup): string {
	if (!group.collapsed) return "▾ click to collapse";
	const count = group.hidden.length;
	return `▸ ${count} earlier message${count === 1 ? "" : "s"} hidden · click to expand`;
}

function hintLines(width: number, group: CollapseGroup, theme: Theme | undefined): string[] {
	const label = barLabel(group);
	const text = theme ? theme.fg("dim", label) : label;
	return ["", truncateToWidth(text, Math.max(1, width), "")];
}

/* ------------------------------------------------------------------ */
/* Hiding and showing components                                       */
/* ------------------------------------------------------------------ */

/** Swap a component's render for an empty one. Returns true when it changed. */
function setComponentHidden(component: Component, hidden: boolean): boolean {
	const store = component as unknown as Record<symbol, unknown>;
	if (hidden) {
		if (store[RENDER_SYMBOL]) return false;
		store[RENDER_SYMBOL] = component.render.bind(component);
		component.render = () => [];
		component.invalidate?.();
		return true;
	}
	const original = store[RENDER_SYMBOL] as ((width: number) => string[]) | undefined;
	if (!original) return false;
	component.render = original;
	store[RENDER_SYMBOL] = undefined;
	component.invalidate?.();
	return true;
}

/* ------------------------------------------------------------------ */
/* Per-turn patches                                                    */
/* ------------------------------------------------------------------ */

/** Append the hint bar to the turn's user message and handle clicks on it. */
function installStart(
	group: CollapseGroup,
	getTheme: () => Theme | undefined,
	onToggle: (group: CollapseGroup) => void,
): void {
	const start = group.start as Component & Record<symbol, unknown>;
	const existing = start[START_SYMBOL] as StartState | undefined;
	if (existing) {
		// Reloaded extension code: point the patch at the new group/callbacks.
		existing.group = group;
		existing.getTheme = getTheme;
		existing.onToggle = onToggle;
		return;
	}

	const state: StartState = {
		group,
		getTheme,
		onToggle,
		originalRender: group.start.render.bind(group.start),
		originalMouse: group.start.handleMouse?.bind(group.start),
	};
	start[START_SYMBOL] = state;

	start.render = (width: number): string[] => {
		const current = start[START_SYMBOL] as StartState;
		const lines = current.originalRender(width);
		current.barStart = lines.length;
		return [...lines, ...hintLines(width, current.group, current.getTheme())];
	};

	// The bar lives inside this component, so handle its clicks here as well: the
	// chat container's handler is not always the first (other extensions wrap it).
	start.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		const current = start[START_SYMBOL] as StartState;
		if (
			event.type === "click" &&
			event.button === "left" &&
			current.barStart !== undefined &&
			event.y >= current.barStart
		) {
			current.onToggle(current.group);
			return { handled: true };
		}
		return current.originalMouse?.(event);
	};
}

/** Put the start component's own render and mouse handler back. */
function releaseStart(component: Component): void {
	const store = component as unknown as Record<symbol, unknown>;
	const state = store[START_SYMBOL] as StartState | undefined;
	if (!state) return;
	component.render = state.originalRender;
	if (state.originalMouse) component.handleMouse = state.originalMouse;
	store[START_SYMBOL] = undefined;
	component.invalidate?.();
}

/**
 * Install the click handler on a group's anchor: the final reply, or the turn's
 * last child when a new user message cut the turn short.
 */
function installAnchor(group: CollapseGroup, onToggle: (group: CollapseGroup) => void): void {
	const anchor = group.anchor as Component & Record<symbol, unknown>;
	const existing = anchor[ANCHOR_SYMBOL] as AnchorState | undefined;
	if (existing) {
		existing.group = group;
		existing.onToggle = onToggle;
		return;
	}

	const state: AnchorState = { group, onToggle };
	anchor[ANCHOR_SYMBOL] = state;
	const originalMouse = anchor.handleMouse?.bind(anchor);

	anchor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		// Let interactive children (e.g. a thinking block) consume the click first.
		const result = originalMouse?.(event);
		if (result) return result;
		if (event.type === "click" && event.button === "left") {
			const current = anchor[ANCHOR_SYMBOL] as AnchorState;
			current.onToggle(current.group);
			return { handled: true };
		}
		return undefined;
	};
}

/**
 * Replace the chat container's render with an equivalent loop that records each
 * child's row range, which is what makes the sticky bar (and bar clicks)
 * possible. `Container.render` is little more than a concatenation of the
 * children's lines, so replicating it keeps the transcript identical apart from
 * the pinned hint.
 */
function installChat(chat: LooseComponent, state: ChatState): void {
	const store = chat as unknown as Record<symbol, ChatState | undefined>;
	const existing = store[CHAT_SYMBOL];
	if (existing) {
		// Reloaded extension code: refresh the callbacks, keep the last bar map.
		existing.getGroups = state.getGroups;
		existing.getTheme = state.getTheme;
		existing.getViewportTop = state.getViewportTop;
		existing.onToggle = state.onToggle;
		return;
	}
	store[CHAT_SYMBOL] = state;

	chat.render = (width: number): string[] => {
		const current = store[CHAT_SYMBOL] as ChatState;
		const children = (chat.children ?? []) as Component[];
		const rows = new Map<Component, { start: number; height: number }>();
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		const lines: string[] = [];
		let row = 0;

		for (const child of children) {
			const childLines = child.render(width);
			rows.set(child, { start: row, height: childLines.length });
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) lines.push(line);
			row += childLines.length;
		}
		// Same bookkeeping as `Container.render`, whose work this replaces.
		(chat as unknown as { mouseLayout?: unknown }).mouseLayout = { width, children: mouseChildren };

		current.bars = [];
		current.pinned = undefined;
		const top = current.getViewportTop(width);

		for (const group of current.getGroups()) {
			const startRows = rows.get(group.start);
			const anchorRows = rows.get(group.anchor);
			if (!startRows || !anchorRows) continue;

			// The hint is the last HINT_LINES lines of the user message's render.
			const barEnd = startRows.start + startRows.height;
			current.bars.push({ group, from: barEnd - HINT_LINES, to: barEnd });

			// Sticky only while expanded: the point is to reach "collapse" from
			// inside the body. Collapsed turns keep the bar at the turn's top.
			if (current.pinned || group.collapsed || top === undefined) continue;
			const turnEnd = anchorRows.start + anchorRows.height;
			if (top < barEnd || top >= turnEnd) continue;
			// Keep scanning: every bar must stay clickable, including the ones
			// below the pinned turn.
			current.pinned = { group, row: top };
		}

		const pinned = current.pinned;
		if (pinned && pinned.row >= 0 && pinned.row < lines.length) {
			const label = barLabel(pinned.group);
			const theme = current.getTheme();
			const text = theme ? theme.fg("dim", label) : label;
			// Cover the whole row: the pinned bar hides the row it sits on
			// instead of shifting everything below it.
			lines[pinned.row] = compositeTuiLine(lines[pinned.row] ?? "", text, 0, width, width);
		}

		return lines;
	};

	const originalMouse = chat.handleMouse?.bind(chat);

	chat.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		const current = store[CHAT_SYMBOL] as ChatState;
		if (event.type === "click" && event.button === "left") {
			if (current.pinned && event.y === current.pinned.row) {
				current.onToggle(current.pinned.group);
				return { handled: true };
			}
			for (const bar of current.bars) {
				if (event.y >= bar.from && event.y < bar.to) {
					current.onToggle(bar.group);
					return { handled: true };
				}
			}
		}
		// Plain containers have no child boxes of their own, so the chat container is
		// what forwards clicks to the messages: never swallow anything but a bar hit.
		return originalMouse?.(event);
	};
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function turnCollapseExtension(pi: ExtensionAPI): void {
	let tui: TUI | undefined;
	let context: ExtensionContext | undefined;
	const groups = new Map<Component, CollapseGroup>();
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshAttempts = 0;

	const getTheme = (): Theme | undefined => context?.ui.theme;

	const requestRender = (): void => {
		tui?.requestRender();
	};

	const applyGroup = (group: CollapseGroup): void => {
		let changed = false;
		for (const component of group.hidden) {
			if (setComponentHidden(component, group.collapsed)) changed = true;
		}
		if (changed) {
			group.anchor.invalidate?.();
			requestRender();
		}
	};

	const toggle = (group: CollapseGroup): void => {
		group.collapsed = !group.collapsed;
		applyGroup(group);
		requestRender();
	};

	/**
	 * Walk the chat container and return one group per completed turn, reusing
	 * the existing group objects so per-turn expansion state is preserved.
	 */
	const collectGroups = (chat: LooseComponent): CollapseGroup[] => {
		const children = chat.children;
		if (!Array.isArray(children) || children.length === 0) return [];

		// Forget groups whose components were replaced (compaction, /tree, new session).
		const present = new Set(children);
		for (const [anchor, group] of groups) {
			if (present.has(anchor)) continue;
			for (const component of group.hidden) setComponentHidden(component, false);
			releaseStart(group.start);
			groups.delete(anchor);
		}

		const result: CollapseGroup[] = [];
		let turnStart = -1;
		/** Index of the current turn's last child, whatever its kind. */
		let lastIndex = -1;
		let finalIndex = -1;
		let finalMessage: MessageLike | undefined;

		/** `closedByUser` is true when a new user message ended the turn. */
		const finalizeTurn = (closedByUser: boolean): void => {
			const startIndex = turnStart;
			const end = lastIndex;
			const assistantIndex = finalIndex;
			const message = finalMessage;
			turnStart = -1;
			lastIndex = -1;
			finalIndex = -1;
			finalMessage = undefined;

			if (startIndex < 0 || end < 0 || end <= startIndex + 1) return;

			// A turn whose last assistant message still calls tools has no final
			// reply. When a new user message cut it short, anchor on its last child
			// so the interrupted work still collapses. The trailing turn is left
			// alone: while the agent is still working there is no group yet.
			const hasFinalReply = assistantIndex >= 0 && !hasToolCalls(message);
			if (!hasFinalReply && !closedByUser) return;
			const anchorIndex = hasFinalReply ? assistantIndex : end;

			const hidden = children.slice(startIndex + 1, anchorIndex);
			if (hidden.length === 0) return;

			const start = children[startIndex];
			const anchor = children[anchorIndex];
			const existing = groups.get(anchor);
			const group = existing ?? { start, anchor, hidden, collapsed: true };
			// A rebuilt user message (edit, retry) replaces the component the hint was
			// patched onto; drop the stale patch before pointing the group at the new one.
			if (existing && existing.start !== start) releaseStart(existing.start);
			group.start = start;
			group.hidden = hidden;
			if (!existing) groups.set(anchor, group);
			result.push(group);
		};

		for (let index = 0; index < children.length; index++) {
			const child = children[index];
			if (isUserMessageComponent(child)) {
				finalizeTurn(true);
				turnStart = index;
				continue;
			}
			lastIndex = index;
			if (isAssistantMessageComponent(child)) {
				finalIndex = index;
				finalMessage = child.lastMessage;
			}
		}
		finalizeTurn(false);

		return result;
	};

	/** First visible row of the chat container, in chat-local row numbers. */
	const makeViewportTopGetter = (chat: LooseComponent) => (width: number): number | undefined => {
		const transcript = findTranscript(tui);
		const scroll = transcript?.scroll;
		const children = (transcript?.document as LooseComponent | undefined)?.children;
		if (!scroll || !Array.isArray(children)) return undefined;

		// Rows the header and the loaded-resources block take above the chat.
		let above = 0;
		for (const child of children) {
			if (child === chat) return scroll.scrollTop - above;
			above += safeRenderHeight(child, width);
		}
		return undefined;
	};

	const refresh = (): boolean => {
		if (!tui || tui.mode !== "fullscreen") return false;
		const chat = findChat(tui);
		if (!chat) return false;
		// Keep the startup retry alive until the initial transcript is rendered.
		if (!Array.isArray(chat.children) || chat.children.length === 0) return false;

		installChat(chat, {
			getGroups: () => [...groups.values()],
			getTheme,
			getViewportTop: makeViewportTopGetter(chat),
			onToggle: toggle,
			bars: [],
		});

		for (const group of collectGroups(chat)) {
			installStart(group, getTheme, toggle);
			installAnchor(group, toggle);
			applyGroup(group);
		}
		return true;
	};

	/** Retry across a few frames: the transcript may not exist yet on load. */
	const scheduleRefresh = (): void => {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshAttempts = 0;

		const attempt = (): void => {
			refreshTimer = undefined;
			if (refresh()) return;
			if (refreshAttempts >= 40) return;
			refreshAttempts += 1;
			refreshTimer = setTimeout(attempt, 50);
		};

		refreshTimer = setTimeout(attempt, 0);
	};

	pi.registerCommand("turn-collapse", {
		description: "Expand or collapse all completed turns in the transcript",
		handler: async (_args, ctx) => {
			context = ctx;
			if (ctx.mode !== "tui" || !tui || tui.mode !== "fullscreen") {
				ctx.ui.notify("/turn-collapse needs interactive fullscreen mode", "info");
				return;
			}
			refresh();
			const list = [...groups.values()];
			if (list.length === 0) {
				ctx.ui.notify("No completed turns to collapse", "info");
				return;
			}
			// If anything is collapsed, expand everything; otherwise collapse everything.
			const target = !list.some((group) => group.collapsed);
			for (const group of list) {
				group.collapsed = target;
				applyGroup(group);
			}
			ctx.ui.notify(target ? "Collapsed all turns" : "Expanded all turns", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		if (ctx.mode !== "tui") return;

		// Zero-height widget whose only purpose is to hand us the TUI instance.
		const capture: Component & { dispose?(): void } = { render: () => [], invalidate() {} };
		ctx.ui.setWidget(
			WIDGET_KEY,
			(nextTui) => {
				tui = nextTui;
				return capture;
			},
			{ placement: "belowEditor" },
		);

		scheduleRefresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
		if (ctx.mode !== "tui") return;
		refresh();
		// Some notices are appended around settlement; reconcile once more.
		scheduleRefresh();
	});

	// These events clear and rebuild the transcript; re-apply afterwards.
	pi.on("session_compact", (_event, ctx) => {
		context = ctx;
		scheduleRefresh();
	});

	pi.on("session_tree", (_event, ctx) => {
		context = ctx;
		scheduleRefresh();
	});

	pi.on("session_shutdown", () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
		for (const group of groups.values()) {
			for (const component of group.hidden) setComponentHidden(component, false);
			releaseStart(group.start);
		}
		groups.clear();
		tui = undefined;
		context = undefined;
	});
}
