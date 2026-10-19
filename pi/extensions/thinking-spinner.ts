/**
 * Thinking spinner.
 *
 * Adds a working-style animated spinner to the thinking block while the model
 * is streaming reasoning, then reports how long thinking took once it ends:
 *
 *   hidden thinking block:   ⠋ Thinking... (12s) →  Thinking for 1m 30s
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

/** `420ms`, `45s`, `1m 30s`, or `1h 2m 3s`. The `Thinking for ` prefix is added by the caller. */
function formatThinkingDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;

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
	/** The run currently being timed, or undefined when no run is active. */
	let run: { startedAt: number; text: string } | undefined;
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

	/**
	 * Finish the active run exactly once and return its duration. Any event that
	 * ends the thinking stream may arrive before `thinking_end` (for example
	 * `text_start`), so every path funnels through here instead of relying on
	 * `thinking_end` to remember the duration.
	 */
	const finalizeRun = (): number | undefined => {
		if (!run) return undefined;
		const durationMs = Date.now() - run.startedAt;
		if (run.text.trim()) rememberThinking(run.text, durationMs);
		run = undefined;
		return durationMs;
	};

	/** Live label while thinking: `⠋ Thinking... (12s)`, with elapsed time appended. */
	const liveLabel = (): string => {
		if (!run) return `${frame()} ${DEFAULT_LABEL}`;
		const elapsed = formatThinkingDuration(Date.now() - run.startedAt);
		return `${frame()} ${DEFAULT_LABEL} (${elapsed})`;
	};

	const tick = (): void => {
		if (!tui || !run) return;
		// Cache the target: a full DFS every 80ms is unnecessary.
		const component = target ?? findThinkingComponent(tui);
		if (!component) return;
		target = component;
		component.setHiddenThinkingLabel(liveLabel());
		tui.requestRender();
	};

	const start = (): void => {
		// No TUI (JSON/print/RPC): nothing to animate.
		if (!tui) return;
		if (!run) run = { startedAt: Date.now(), text: "" };
		if (target === undefined) target = findThinkingComponent(tui);
		if (timer) return;
		tick();
		timer = setInterval(tick, INTERVAL_MS);
	};

	const stop = (): void => {
		const wasActive = run !== undefined;
		const durationMs = finalizeRun();
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (!wasActive) return;

		const component = target ?? (tui ? findThinkingComponent(tui) : undefined);
		target = undefined;

		const label =
			durationMs !== undefined ? `Thinking for ${formatThinkingDuration(durationMs)}` : DEFAULT_LABEL;
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
		if (context.isStreaming && run && markdown.trim() === run.text.trim()) {
			return `${frame()} ${markdown}`;
		}

		const durationMs = completedThinking.get(markdown.trim());
		if (durationMs === undefined) return markdown;
		return `${markdown}\n\nThinking for ${formatThinkingDuration(durationMs)}`;
	});

	pi.on("message_start", (event) => {
		if (!isAssistantMessage(event.message)) return;
		// Finalize any run left over from the previous message before resetting.
		stop();
		target = undefined;
	});

	pi.on("message_update", (event) => {
		if (!isAssistantMessage(event.message)) return;
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start" || update.type === "thinking_delta") {
			const text = thinkingRunText(event.message, update.contentIndex);
			if (run) run.text = text;
			else if (tui) run = { startedAt: Date.now(), text };
			start();
			return;
		}

		if (update.type === "thinking_end") {
			const text = thinkingRunText(event.message, update.contentIndex);
			if (run) run.text = text;
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
		stop();
		tui = undefined;
		completedThinking.clear();
		if (ctx.mode !== "tui") return;

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
