/**
 * Working elapsed time extension.
 *
 * Adds a live elapsed time to the working indicator embedded in the input
 * border while pi is busy:
 *
 *   ── ⠋ Working (12s) ────────────────────────────
 *
 * The timer runs from `agent_start` until `agent_settled`, the same interval
 * used by the elapsed-time extension's final notification. Automatic retries,
 * compaction, and queued continuations therefore keep accumulating toward one
 * total instead of restarting the clock.
 *
 * The working message is restored to pi's default after the run settles, so
 * later built-in status rows (compaction, retry, ...) keep their own text.
 *
 * Usage: pi -e ./working-elapsed.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UPDATE_INTERVAL_MS = 1000;

/** `12s`, `2m 3s`, or `1h 2m 3s`. */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m ${seconds}s`;
}

function workingMessage(startMs: number): string {
	return `Working (${formatElapsed(Date.now() - startMs)})`;
}

export default function (pi: ExtensionAPI) {
	let startMs: number | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		// Keep the first start so retries/continuations count toward one task.
		if (startMs !== null) return;

		startMs = Date.now();
		if (!ctx.hasUI) return;

		ctx.ui.setWorkingMessage(workingMessage(startMs));
		stopTimer();
		timer = setInterval(() => {
			if (startMs === null) return;
			ctx.ui.setWorkingMessage(workingMessage(startMs));
		}, UPDATE_INTERVAL_MS);
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopTimer();
		startMs = null;
		if (ctx.hasUI) ctx.ui.setWorkingMessage(undefined);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		startMs = null;
	});
}
