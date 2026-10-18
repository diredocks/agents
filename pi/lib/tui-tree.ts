/**
 * Shared helpers for extensions that inspect Pi's live terminal component tree.
 *
 * Pi has no public "transcript" API, so several extensions reach into the
 * runtime tree (`tui.layoutRoot`, container `children`, and the private
 * `text`/`lastMessage` fields of the message components). Keep every such
 * access here so a Pi update only needs to fix one file.
 *
 * Display-only: nothing here changes a session or the model context.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";

/** Message-like shape carried by AssistantMessageComponent. */
export interface MessageLike {
	role?: string;
	content?: Array<{ type?: string }>;
}

/** The loose component shape these helpers rely on. */
export interface LooseComponent extends Component {
	children?: Component[];
	/** Private on UserMessageComponent, present at runtime. */
	text?: string;
	/** Private on AssistantMessageComponent, present at runtime. */
	lastMessage?: MessageLike;
}

export interface ScrollableComponent extends Component {
	children: Component[];
	readonly scrollTop: number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
	getContentWidth(width: number): number;
}

/** A user message renders as a Container that carries its raw text. */
export function isUserMessageComponent(node: unknown): node is LooseComponent & { text: string } {
	if (!node || typeof node !== "object") return false;
	const candidate = node as { text?: unknown; children?: unknown };
	return typeof candidate.text === "string" && Array.isArray(candidate.children);
}

/** An assistant message component carries its `lastMessage` at runtime. */
export function isAssistantMessageComponent(node: unknown): node is LooseComponent & { lastMessage: MessageLike } {
	if (!node || typeof node !== "object") return false;
	const candidate = node as { lastMessage?: MessageLike };
	return candidate.lastMessage?.role === "assistant";
}

/** Render a component only to learn its height; never let a bad render crash. */
export function safeRenderHeight(node: unknown, width: number): number {
	if (!node || typeof node !== "object") return 0;
	try {
		const lines = (node as Component).render(width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

/** First scroll view reachable from the layout root (the transcript). */
export function findScrollView(node: unknown): ScrollableComponent | undefined {
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

/** The transcript scroll view and its document container. */
export function findTranscript(
	tui: TUI | undefined,
): { scroll: ScrollableComponent; document: Component } | undefined {
	if (!tui) return undefined;
	const root = (tui as unknown as { layoutRoot?: unknown }).layoutRoot;
	const scroll = findScrollView(root);
	const document = scroll?.children[0];
	if (!scroll || !document) return undefined;
	return { scroll, document };
}

/** Start rows of every user message in the rendered transcript, oldest first. */
export function collectUserMessageRows(root: unknown, width: number): number[] {
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

/** User message components with their start row and text, oldest first. */
export function collectUserMessages(
	root: unknown,
	width: number,
): Array<{ component: LooseComponent & { text: string }; text: string; row: number }> {
	const items: Array<{ component: LooseComponent & { text: string }; text: string; row: number }> = [];

	const walk = (node: unknown, baseRow: number): void => {
		if (isUserMessageComponent(node)) items.push({ component: node, text: node.text, row: baseRow });

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
