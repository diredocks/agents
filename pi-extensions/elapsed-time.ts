/**
 * Elapsed time extension - shows how long a task took once it finishes,
 * together with the model(s) that served the request.
 *
 * Times from `agent_start` (the start of a run) until `agent_settled` (the
 * point where no automatic retry, compaction, or queued continuation will
 * run), so retries and continuations are included in the total.
 *
 * The model is read from the assistant messages recorded after the run
 * started, so it reflects what actually served each request. In particular,
 * a virtual model that routes to physical models reports the routed
 * (`provider/model`) targets rather than the virtual selection. It falls
 * back to the selected `ctx.model` when no response was recorded, for
 * example when a run is aborted before the model answers.
 *
 * Usage: pi -e ./elapsed-time.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function formatDuration(ms: number): string {
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	if (minutes < 60) return `${minutes}m ${seconds.toFixed(1)}s`;

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return `${hours}h ${restMinutes}m ${seconds.toFixed(0)}s`;
}

/** Label for an assistant message's model, including a provider-reported concrete model. */
function formatResponseModel(message: { provider: string; model: string; responseModel?: string }): string {
	const id =
		message.responseModel && message.responseModel !== message.model
			? `${message.model} (${message.responseModel})`
			: message.model;
	return `${message.provider}/${id}`;
}

/** Label for the currently selected model, if any. */
function formatSelectedModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** Distinct models used by assistant responses recorded at or after `sinceIso`. */
function collectUsedModels(ctx: ExtensionContext, sinceIso: string): string[] {
	const models: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.timestamp < sinceIso) continue;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const label = formatResponseModel(entry.message);
		if (!models.includes(label)) models.push(label);
	}
	return models;
}

export default function (pi: ExtensionAPI) {
	let startMs: number | null = null;
	let startIso: string | null = null;

	pi.on("agent_start", () => {
		// Keep the first start so retries/continuations count toward one task.
		if (startMs === null) {
			startMs = Date.now();
			startIso = new Date(startMs).toISOString();
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		if (startMs === null || startIso === null) return;

		const elapsedMs = Date.now() - startMs;
		const sinceIso = startIso;
		startMs = null;
		startIso = null;
		if (elapsedMs <= 0) return;

		const usedModels = collectUsedModels(ctx, sinceIso);
		const model = usedModels.length > 0 ? usedModels.join(" → ") : formatSelectedModel(ctx);
		const suffix = event.aborted ? " (aborted)" : "";
		const message = `Elapsed ${formatDuration(elapsedMs)}${model ? ` · ${model}` : ""}${suffix}`;

		if (ctx.hasUI) {
			ctx.ui.notify(message, "info");
		} else {
			console.log(message);
		}
	});
}
