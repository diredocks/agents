/**
 * Click a user prompt to branch the session from there.
 *
 * Left-clicking a user message in the transcript asks for confirmation and,
 * when accepted, moves the session-tree leaf back to that message: the prompt
 * text is restored to the editor and everything after it leaves the active
 * branch (it stays in the tree, reachable through `/tree`). Sending a new
 * message then creates a sibling branch instead of continuing the old one.
 *
 * This mirrors what `/tree` does after you pick an entry, but starts from a
 * click on the prompt itself.
 *
 * Implementation notes:
 * - Fullscreen layout dispatches mouse events to the transcript container with
 *   `y` already in transcript-content coordinates, so a click is mapped back to
 *   a user-message row by accumulating the rendered heights of the container's
 *   children.
 * - `navigateTree()` only exists on the command context, so the click handler
 *   dispatches the `branch-here` command through
 *   `pi.sendUserMessage(..., { expandPromptTemplates: true })`.
 * - The mouse wrapper is stored on the container under a symbol, so `/reload`
 *   replaces it instead of stacking another wrapper.
 *
 * The default `tuiMode` is fullscreen, where mouse input reaches the app. In
 * regular mode the terminal owns the scrollback and mouse clicks are not
 * forwarded; use `/branch-here` there instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

const COMMAND = "branch-here";
const CAPTURE_WIDGET_KEY = "branch-here";
const PATCH_STATE = Symbol.for("@branch-here/patch-state");
const PREVIEW_LENGTH = 200;

interface PatchState {
	handle: (container: PatchableContainer, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

interface PatchableContainer extends Component {
	children?: Component[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

interface UserTarget {
	id: string;
	/** Text as the transcript renders it (for a skill block, the trailing user message). */
	renderedText: string;
}

interface CachedLayout {
	width: number;
	children: Array<{ component: Component; height: number }>;
}

/** Plain text of a user message. */
function userMessageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
		)
		.map((part) => part.text)
		.join("");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Shorten a prompt for a one-line preview. */
function preview(text: string): string {
	const line = singleLine(text);
	return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH)}…` : line;
}

/**
 * User entries that produce a clickable user-message component, in transcript
 * order. Entries with no text render nothing; a skill invocation with no
 * trailing user message renders only the (non-clickable) skill block.
 */
function collectUserTargets(ctx: ExtensionContext): UserTarget[] {
	const targets: UserTarget[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = userMessageText(entry.message);
		if (!text) continue;
		const skill = parseSkillBlock(text);
		if (skill && !skill.userMessage) continue;
		targets.push({ id: entry.id, renderedText: skill?.userMessage ?? text });
	}
	return targets;
}

/** A user message renders as a Container that carries its raw text. */
function isUserMessageComponent(node: unknown): node is Component & { text: string } {
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

/**
 * Row ranges (in transcript-content coordinates) of the clickable user
 * messages. Prefers the container's own mouse layout cache, which the last
 * render already produced at the same width.
 */
function clickRows(
	container: PatchableContainer,
	width: number,
	ctx: ExtensionContext,
): Array<{ start: number; end: number; entryId: string }> {
	const cached = (container as unknown as { mouseLayout?: CachedLayout }).mouseLayout;
	const layout =
		cached && cached.width === width
			? cached.children
			: (container.children ?? []).map((component) => ({
					component,
					height: safeRenderHeight(component, width),
				}));

	const targets = collectUserTargets(ctx);
	let targetIndex = 0;
	let row = 0;
	const rows: Array<{ start: number; end: number; entryId: string }> = [];
	for (const { component, height } of layout) {
		if (isUserMessageComponent(component)) {
			const target = targets[targetIndex++];
			if (target && height > 0) rows.push({ start: row, end: row + height, entryId: target.id });
		}
		row += height;
	}
	return rows;
}

/**
 * Containers whose direct children include a clickable user message. In the
 * interactive transcript that is the chat container, which is nested inside
 * the document container the ScrollView wraps; patching the document instead
 * would never see a user-message child.
 */
function findClickContainers(node: unknown): PatchableContainer[] {
	const result: PatchableContainer[] = [];
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		const children = (candidate as { children?: unknown }).children;
		if (!Array.isArray(children)) return;
		if (children.some(isUserMessageComponent)) result.push(candidate as PatchableContainer);
		for (const child of children) visit(child);
	};
	visit(node);
	return result;
}

/** Build the click handler. Kept as a value so `/reload` can refresh the logic. */
function makeClickHandler(
	getCtx: () => ExtensionContext | undefined,
	onClick: (entryId: string) => void,
): (container: PatchableContainer, event: TuiMouseEvent) => TuiMouseEventResult | undefined {
	return (container, event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const ctx = getCtx();
		if (!ctx) return undefined;

		const hit = clickRows(container, event.width, ctx).find((row) => event.y >= row.start && event.y < row.end);
		if (!hit) return undefined;

		onClick(hit.entryId);
		return { handled: true };
	};
}

/** Route clicks on user messages to `onClick`, without disturbing other handlers. */
function installPatch(
	container: PatchableContainer,
	getCtx: () => ExtensionContext | undefined,
	onClick: (entryId: string) => void,
): void {
	const store = container as unknown as Record<symbol, PatchState | undefined>;
	const existing = store[PATCH_STATE];
	if (existing) {
		// Reloaded extension code: refresh the handler instead of stacking wrappers.
		existing.handle = makeClickHandler(getCtx, onClick);
		return;
	}

	const originalMouse = container.handleMouse?.bind(container);
	store[PATCH_STATE] = { handle: makeClickHandler(getCtx, onClick) };

	container.handleMouse = (event) => {
		const result = originalMouse?.(event);
		if (result) return result;
		return store[PATCH_STATE]?.handle(container, event);
	};
}

export default function branchHereExtension(pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let currentCtx: ExtensionContext | undefined;
	let installTimer: ReturnType<typeof setTimeout> | undefined;

	const onClick = (entryId: string): void => {
		// The command context is the only one with navigateTree(), so hand the
		// click off to our command instead of touching the session here.
		pi.sendUserMessage(`/${COMMAND} ${entryId}`, { expandPromptTemplates: true });
	};

	/** No-argument fallback: pick a prompt from a list (useful in regular mode). */
	const pickEntryId = async (ctx: ExtensionContext): Promise<string | undefined> => {
		const targets = collectUserTargets(ctx);
		if (targets.length === 0) {
			ctx.ui.notify("No user prompts to branch from", "info");
			return undefined;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Pass an entry id: /branch-here <entry-id>", "info");
			return undefined;
		}
		const items = targets.map((target, index) => ({
			id: target.id,
			label: `${index + 1}. ${preview(target.renderedText)}`,
		}));
		const choice = await ctx.ui.select(
			"Branch at which prompt?",
			items.map((item) => item.label),
		);
		if (choice === undefined) return undefined;
		return items.find((item) => item.label === choice)?.id;
	};

	pi.registerCommand(COMMAND, {
		description: "Branch the session at a user prompt (click a prompt to use)",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current response to finish before branching", "warning");
				return;
			}

			const entryId = args.trim() || (await pickEntryId(ctx));
			if (!entryId) return;

			const entry = ctx.sessionManager.getEntry(entryId);
			if (!entry || entry.type !== "message" || entry.message.role !== "user") {
				ctx.ui.notify("No user prompt to branch from", "warning");
				return;
			}

			const text = userMessageText(entry.message);
			const skill = parseSkillBlock(text);
			const shown = preview(skill?.userMessage ?? text);

			const confirmed = !ctx.hasUI
				? true
				: await ctx.ui.confirm(
						"Branch here?",
						`Move the session-tree leaf back to this prompt and put its text in the editor?\n\n> ${shown}\n\nSend a new message afterwards to start a sibling branch.`,
					);
			if (!confirmed) return;

			try {
				const result = await ctx.navigateTree(entryId, { summarize: false });
				if (result.cancelled) ctx.ui.notify("Branch cancelled", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	const applyPatch = (): void => {
		if (!tui || !currentCtx) return;
		const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
		for (const container of findClickContainers(root)) {
			installPatch(container, () => currentCtx, onClick);
		}
	};

	const schedulePatch = (): void => {
		if (installTimer) return;
		// Run after the current render pass and after other extensions that defer
		// their widget/editor setup.
		installTimer = setTimeout(() => {
			installTimer = undefined;
			applyPatch();
		}, 0);
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui") return;

		// Zero-height capture widget: gives us the TUI so we can reach the transcript.
		// Its render callback re-checks for clickable containers, which covers the
		// initial render and containers recreated by other extensions.
		const capture: Component & { dispose?(): void } = {
			render: () => {
				schedulePatch();
				return [];
			},
			invalidate() {},
		};
		ctx.ui.setWidget(
			CAPTURE_WIDGET_KEY,
			(nextTui) => {
				tui = nextTui;
				applyPatch();
				schedulePatch();
				return capture;
			},
			{ placement: "belowEditor" },
		);

		applyPatch();
		schedulePatch();
	});

	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		applyPatch();
	});

	pi.on("session_compact", (_event, ctx) => {
		currentCtx = ctx;
		applyPatch();
	});

	pi.on("message_end", (_event, ctx) => {
		currentCtx = ctx;
		applyPatch();
	});

	pi.on("agent_end", (_event, ctx) => {
		currentCtx = ctx;
		applyPatch();
	});

	pi.on("session_shutdown", () => {
		if (installTimer) {
			clearTimeout(installTimer);
			installTimer = undefined;
		}
		tui = undefined;
		currentCtx = undefined;
	});
}
