/**
 * Thinking spinner.
 *
 * Adds a working-style animated spinner to the thinking block while the model
 * is streaming reasoning, then reports how long thinking took once it ends:
 *
 *   hidden thinking block:   ⠋ Thinking...        →  Thinking for 1m 30s
 *   visible thinking block:  ⠋ <thinking text>    →  <thinking text>
 *
 *                                                     Thinking for 1m 30s
 *
 * Pi renders hidden thinking blocks as a static `Thinking...` label. The label
 * can be changed through the public UI API, but that updates every assistant
 * message in the transcript. To keep this cheap, the plugin passes a TUI widget
 * factory (zero height, below the editor) to capture the TUI, then updates only
 * the streaming AssistantMessageComponent through its public
 * `setHiddenThinkingLabel()` method.
 *
 * Visible thinking blocks are handled by a Markdown transformer for
 * `assistant-thinking`, gated on the current thinking stream being active. The
 * duration is remembered per thinking run so completed blocks keep their footer
 * across re-renders.
 *
 * The spinner uses the same braille frames and 80ms interval as pi's built-in
 * working indicator.
 */

import { appendFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;
const DEFAULT_LABEL = "Thinking...";
/** Cap for the completed-thinking lookup so long sessions cannot grow forever. */
const MAX_REMEMBERED_THINKING = 100;

interface ThinkingLabelComponent {
	setHiddenThinkingLabel(label: string): void;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

/** `45s`, `1m 30s`, or `1h 2m 3s`. The `Thinking for ` prefix is added by the caller. */
function formatThinkingDuration(ms: number): string {
	if (ms < 1000) return "<1s";

	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/**
 * The markdown a visible thinking block renders as: consecutive thinking blocks
 * are joined with a blank line by AssistantMessageComponent.updateContent().
 */
function thinkingRunText(message: AssistantMessage, contentIndex: number): string {
	const content = message.content;
	if (contentIndex < 0 || contentIndex >= content.length) return "";

	let start = contentIndex;
	while (start > 0 && content[start - 1]?.type === "thinking") start--;
	let end = contentIndex;
	while (end + 1 < content.length && content[end + 1]?.type === "thinking") end++;

	const blocks: string[] = [];
	for (let i = start; i <= end; i++) {
		const block = content[i];
		if (block?.type !== "thinking") continue;
		const text = block.thinking.trim();
		if (text) blocks.push(text);
	}
	return blocks.join("\n\n");
}

/** Depth-first walk; the last match is the most recent assistant message. */
function findThinkingComponent(tui: TUI): ThinkingLabelComponent | undefined {
	let found: ThinkingLabelComponent | undefined;

	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;

		const candidate = node as {
			setHiddenThinkingLabel?: unknown;
			children?: unknown;
		};

		if (typeof candidate.setHiddenThinkingLabel === "function") {
			found = candidate as ThinkingLabelComponent;
		}

		if (Array.isArray(candidate.children)) {
			for (const child of candidate.children) visit(child);
		}
	};

	for (const child of tui.children) visit(child);
	return found;
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let thinkingActive = false;
	let thinkingStartedAt: number | undefined;
	/** Thinking text of the run currently streaming, so only that run gets the spinner. */
	let currentThinkingText = "";
	/** The component currently being animated, so we touch only that one. */
	let target: ThinkingLabelComponent | undefined;
	/** Completed thinking run text -> duration, so visible blocks keep their footer. */
	const completedThinking = new Map<string, number>();

	const frame = (): string => FRAMES[Math.floor(Date.now() / INTERVAL_MS) % FRAMES.length] ?? FRAMES[0]!;

	const rememberThinking = (text: string, durationMs: number): void => {
		const key = text.trim();
		if (!key) return;

		// Re-insert to refresh recency, then evict the oldest entry at the cap.
		completedThinking.delete(key);
		completedThinking.set(key, durationMs);
		if (completedThinking.size > MAX_REMEMBERED_THINKING) {
			const oldest = completedThinking.keys().next().value;
			if (oldest !== undefined) completedThinking.delete(oldest);
		}
	};

	const durationLabel = (): string | undefined => {
		if (thinkingStartedAt === undefined) return undefined;
		return `Thinking for ${formatThinkingDuration(Date.now() - thinkingStartedAt)}`;
	};

	const tick = (): void => {
		if (!thinkingActive || !tui) return;
		const component = findThinkingComponent(tui);
		if (!component) return;
		target = component;
		component.setHiddenThinkingLabel(`${frame()} ${DEFAULT_LABEL}`);
		tui.requestRender();
	};

	const start = (): void => {
		if (thinkingStartedAt === undefined) thinkingStartedAt = Date.now();
		thinkingActive = true;
		// Grab the newest assistant component now so a very short thinking run
		// still reports its duration on the right message.
		if (tui) target = findThinkingComponent(tui) ?? target;
		if (timer) return;
		tick();
		timer = setInterval(tick, INTERVAL_MS);
	};

	const stop = (): void => {
		const wasActive = thinkingActive;
		thinkingActive = false;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}

		const component = target ?? (tui ? findThinkingComponent(tui) : undefined);
		target = undefined;
		if (!wasActive) return;

		const label = durationLabel() ?? DEFAULT_LABEL;
		thinkingStartedAt = undefined;
		if (component) {
			component.setHiddenThinkingLabel(label);
			tui?.requestRender();
		}
	};

	// Visible thinking blocks: prefix the streaming thinking markdown with the
	// current frame while it streams, then append the finished duration. Only the
	// streaming component gets `isStreaming: true`, but completed blocks are
	// matched by their text so they keep their footer across re-renders.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		appendFileSync(`/tmp/thinking-debug-${process.pid}.log`, `TRANSFORM streaming=${context.isStreaming} active=${thinkingActive} current=${JSON.stringify(currentThinkingText.trim().slice(0, 40))} markdown=${JSON.stringify(markdown.trim().slice(0, 40))} keys=${JSON.stringify([...completedThinking.keys()].map((k) => k.slice(0, 40)))} match=${completedThinking.has(markdown.trim())}\n`);
		if (context.isStreaming && thinkingActive && markdown.trim() === currentThinkingText.trim()) {
			return `${frame()} ${markdown}`;
		}

		const durationMs = completedThinking.get(markdown.trim());
		if (durationMs === undefined) return markdown;
		return `${markdown}\n\nThinking for ${formatThinkingDuration(durationMs)}`;
	});

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;
		// A new assistant message starts with a fresh spinner/label state. The
		// previous component keeps the duration label it was given.
		thinkingStartedAt = undefined;
		currentThinkingText = "";
		target = undefined;
	});

	pi.on("message_update", (event) => {
		if (!isAssistantMessage(event.message)) return;
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start" || update.type === "thinking_delta") {
			currentThinkingText = thinkingRunText(event.message, update.contentIndex);
			start();
			return;
		}

		if (update.type === "thinking_end") {
			const runText = thinkingRunText(event.message, update.contentIndex);
			appendFileSync(`/tmp/thinking-debug-${process.pid}.log`, `END startedAt=${thinkingStartedAt} runText=${JSON.stringify(runText.slice(0, 60))} len=${runText.length}\n`);
			currentThinkingText = runText;
			if (thinkingStartedAt !== undefined) {
				rememberThinking(runText, Date.now() - thinkingStartedAt);
			}
			stop();
			return;
		}

		if (
			update.type === "text_start" ||
			update.type === "toolcall_start" ||
			update.type === "done" ||
			update.type === "error"
		) {
			stop();
		}
	});

	pi.on("message_end", (event) => {
		if (isAssistantMessage(event.message)) stop();
	});
	pi.on("agent_end", () => stop());

	pi.on("session_shutdown", () => {
		stop();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		stop();
		completedThinking.clear();
		tui = undefined;

		// Below-editor avoids the blank leading spacer that above-editor widgets
		// add. The component itself is zero-height; it only captures the TUI.
		const capture: Component & { dispose: () => void } = {
			render: () => [],
			invalidate() {},
			dispose: () => stop(),
		};
		ctx.ui.setWidget(
			"thinking-spinner",
			(t) => {
				tui = t;
				return capture;
			},
			{ placement: "belowEditor" },
		);
	});
}
