/**
 * Turn Collapse
 *
 * After a task finishes, hide everything the agent produced between the user's
 * prompt of that turn and the model's final reply: intermediate assistant
 * messages (the ones that only carry tool calls), every tool execution, and the
 * spacing around them. Only the user prompt and the final answer stay visible.
 *
 * The final reply gets a small dim hint line above it. Clicking anywhere on
 * the final reply expands the hidden messages again; clicking once more
 * collapses them.
 *
 * Every completed turn in the transcript is collapsed, not just the newest one.
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
 *   5. The anchor component (the final reply, or the turn's last child) gets
 *      `render()`/`handleMouse()` patched so it shows the hint line and toggles
 *      the group on click.
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
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	findTranscript,
	isAssistantMessageComponent,
	isUserMessageComponent,
	type LooseComponent,
	type MessageLike,
} from "../../lib/tui-tree.ts";

const WIDGET_KEY = "turn-collapse";

/** Marks an anchor component that already has the click/hint patch installed. */
const PATCH_SYMBOL = Symbol.for("@turn-collapse/patch");
/** Stores a hidden component's original render function while it is hidden. */
const RENDER_SYMBOL = Symbol.for("@turn-collapse/original-render");

/**
 * Number of lines the hint adds above the anchor's own render (a blank line and
 * the label). Mouse coordinates arrive relative to the patched component, so
 * they must be shifted back before being handed to the original handler -- the
 * anchor's own `mouseLayout` is built from the unpadded render.
 */
const ANCHOR_HINT_LINES = 2;

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
	anchor: Component;
	hidden: Component[];
	collapsed: boolean;
}

/**
 * Mutable state stored on an anchor component. Kept in a symbol property so a
 * reloaded extension updates the callbacks instead of stacking another patch.
 */
interface AnchorState {
	group: CollapseGroup;
	getTheme: () => Theme | undefined;
	onChange: () => void;
}

/* ------------------------------------------------------------------ */
/* Component tree inspection                                           */
/* ------------------------------------------------------------------ */

function hasToolCalls(message: MessageLike | undefined): boolean {
	return Array.isArray(message?.content) && message.content.some((part) => part?.type === "toolCall");
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

/**
 * Install the hint line and click handler on a group's anchor: the final reply,
 * or the turn's last child when a new user message cut the turn short.
 */
function installAnchor(group: CollapseGroup, getTheme: () => Theme | undefined, onChange: () => void): void {
	const anchor = group.anchor as Component & Record<symbol, unknown>;
	const existing = anchor[PATCH_SYMBOL] as AnchorState | undefined;
	if (existing) {
		// Reloaded extension code: point the patch at the new group/callbacks.
		existing.group = group;
		existing.getTheme = getTheme;
		existing.onChange = onChange;
		return;
	}

	const state: AnchorState = { group, getTheme, onChange };
	anchor[PATCH_SYMBOL] = state;

	const originalRender = group.anchor.render.bind(group.anchor);
	const originalMouse = group.anchor.handleMouse?.bind(group.anchor);

	group.anchor.render = (width: number): string[] => {
		const lines = originalRender(width);
		const current = anchor[PATCH_SYMBOL] as AnchorState;
		const count = current.group.hidden.length;
		const label = current.group.collapsed
			? `▸ ${count} earlier message${count === 1 ? "" : "s"} hidden · click to expand`
			: "▾ click to collapse";
		const theme = current.getTheme();
		return ["", theme ? theme.fg("dim", label) : label, ...lines];
	};

	group.anchor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
		// Let interactive children (e.g. a thinking block) consume the click first.
		// The hint is prepended by our render, but the original handler lays out
		// its children from the unpadded render, so translate the coordinates.
		const result = originalMouse?.({ ...event, y: event.y - ANCHOR_HINT_LINES });
		if (result) return result;
		if (event.type === "click" && event.button === "left") {
			const current = anchor[PATCH_SYMBOL] as AnchorState;
			current.group.collapsed = !current.group.collapsed;
			current.onChange();
			return { handled: true };
		}
		return undefined;
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
			const start = turnStart;
			const end = lastIndex;
			const assistantIndex = finalIndex;
			const message = finalMessage;
			turnStart = -1;
			lastIndex = -1;
			finalIndex = -1;
			finalMessage = undefined;

			if (start < 0 || end < 0 || end <= start + 1) return;

			// A turn whose last assistant message still calls tools has no final
			// reply. When a new user message cut it short, anchor on its last child
			// so the interrupted work still collapses. The trailing turn is left
			// alone: while the agent is still working there is no group yet.
			const hasFinalReply = assistantIndex >= 0 && !hasToolCalls(message);
			if (!hasFinalReply && !closedByUser) return;
			const anchorIndex = hasFinalReply ? assistantIndex : end;

			const hidden = children.slice(start + 1, anchorIndex);
			if (hidden.length === 0) return;

			const anchor = children[anchorIndex];
			const existing = groups.get(anchor);
			const group = existing ?? { anchor, hidden, collapsed: true };
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

	const refresh = (): boolean => {
		if (!tui || tui.mode !== "fullscreen") return false;
		const chat = findChat(tui);
		if (!chat) return false;
		// Keep the startup retry alive until the initial transcript is rendered.
		if (!Array.isArray(chat.children) || chat.children.length === 0) return false;

		for (const group of collectGroups(chat)) {
			installAnchor(group, getTheme, () => applyGroup(group));
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
		}
		groups.clear();
		tui = undefined;
		context = undefined;
	});
}
