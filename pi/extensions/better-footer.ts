/**
 * Better footer: compact status line + model placeholder.
 *
 * Replaces the default two-line footer (cwd line + token/context/model line)
 * with a single line, and moves the model/thinking-level indicator into the
 * input editor's placeholder:
 *
 *   footer:  ~/.nix-config on git:main ✗        ↑1.2k ↓3.4k $0.012 5.2%/200k
 *   input:   deepseek-v4.1-flash • high
 *
 * Footer left side follows the zsh ys theme: cwd, "on git:<branch>", and a
 * red ✗ when the working tree is dirty. Session name and extension statuses
 * follow it. Footer right side: token/cost/context stats (right-aligned).
 * The left side is truncated first on narrow terminals.
 *
 * Display-only: neither part affects the session or LLM context.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	renderFakeCursor,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate: number | undefined;
}

/**
 * Default editor plus a placeholder that shows "model • thinking level"
 * whenever the input is empty. Everything else (keybindings, autocomplete,
 * submit, working-status border) is inherited from CustomEditor.
 */
class ModelPlaceholderEditor extends CustomEditor {
	private readonly stylePlaceholder: (text: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getPlaceholder: () => string,
	) {
		// Match the default editor: render working/compaction status in the border.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.stylePlaceholder = theme.borderColor;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.getText().length > 0) return lines;

		const placeholder = this.getPlaceholder();
		if (!placeholder || lines.length < 3) return lines;

		const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const maxPlaceholderWidth = Math.max(0, contentWidth - 1);

		const plain = truncateToWidth(placeholder, maxPlaceholderWidth, "");
		const text = this.stylePlaceholder(plain);
		const fill = " ".repeat(Math.max(0, contentWidth - 1 - visibleWidth(plain)));
		const cursor = `${this.focused ? CURSOR_MARKER : ""}${renderFakeCursor(" ")}`;
		const padding = " ".repeat(paddingX);

		// lines[1] is the single content line when the editor is empty.
		lines[1] = `${padding}${cursor}${text}${fill}${padding}`;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let currentTui: TUI | undefined;
	/** Set by the current footer; refreshes the git dirty marker. */
	let refreshDirty: (() => void) | undefined;

	// The placeholder is read at render time; these ensure a repaint when the
	// model or thinking level changes without any other visible event.
	pi.on("model_select", () => currentTui?.requestRender());
	pi.on("thinking_level_select", () => currentTui?.requestRender());

	// Refresh the ✗ marker after tools that can change the working tree.
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") {
			refreshDirty?.();
		}
	});
	pi.on("turn_end", () => refreshDirty?.());

	pi.on("session_shutdown", () => {
		currentTui = undefined;
		refreshDirty = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const getPlaceholder = (): string => {
			const model = ctx.model;
			if (!model) return "no-model";
			let text = model.id;
			if (model.reasoning) {
				const level = ctx.thinkingLevel || "off";
				text += ` • ${level === "off" ? "thinking off" : level}`;
			}
			return text;
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			currentTui = tui;
			return new ModelPlaceholderEditor(tui, theme, keybindings, getPlaceholder);
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			currentTui = tui;

			// --- git dirty marker (ys-style ✗) ---
			let dirty = false;
			let checkingDirty = false;
			let lastDirtyCheck = 0;
			let refreshTimer: ReturnType<typeof setTimeout> | undefined;
			const DIRTY_CHECK_INTERVAL_MS = 1000;

			const checkDirty = (force: boolean): void => {
				if (!footerData.getGitBranch()) {
					dirty = false;
					return;
				}
				if (checkingDirty) return;
				const now = Date.now();
				if (!force && now - lastDirtyCheck < DIRTY_CHECK_INTERVAL_MS) return;
				lastDirtyCheck = now;
				checkingDirty = true;
				void pi
					.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd })
					.then((result) => {
						dirty = result.code === 0 && result.stdout.trim().length > 0;
					})
					.catch(() => {
						dirty = false;
					})
					.finally(() => {
						checkingDirty = false;
						tui.requestRender();
					});
			};

			const refresh = (): void => {
				if (refreshTimer) return;
				refreshTimer = setTimeout(() => {
					refreshTimer = undefined;
					checkDirty(true);
				}, 100);
			};
			// A branch switch can change the dirty state; force a check instead of
			// waiting for the next periodic render.
			const unsubscribe = footerData.onBranchChange(() => checkDirty(true));
			refreshDirty = refresh;
			checkDirty(true);

			let cachedLeaf: string | null | undefined;
			let cachedTotals: Totals | undefined;

			// Token/cost totals only change when the branch leaf moves. Extension
			// statuses and context usage are cheap enough to read every frame.
			const getTotals = (): Totals => {
				const sessionManager = ctx.sessionManager;
				const leafId = sessionManager.getLeafId();
				if (cachedTotals && cachedLeaf === leafId) return cachedTotals;

				const totals: Totals = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					cacheHitRate: undefined,
				};

				const addUsage = (usage: {
					input: number;
					output: number;
					cacheRead: number;
					cacheWrite: number;
					cost: { total: number };
				}) => {
					totals.input += usage.input;
					totals.output += usage.output;
					totals.cacheRead += usage.cacheRead;
					totals.cacheWrite += usage.cacheWrite;
					totals.cost += usage.cost.total;
				};

				for (const entry of sessionManager.getBranch()) {
					if (entry.type === "message") {
						if (entry.message.role === "assistant") {
							addUsage(entry.message.usage);
							const prompt =
								entry.message.usage.input +
								entry.message.usage.cacheRead +
								entry.message.usage.cacheWrite;
							if (prompt > 0) {
								totals.cacheHitRate = (entry.message.usage.cacheRead / prompt) * 100;
							}
						} else if (entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(entry.message.usage);
						}
					} else if (entry.type === "usage") {
						addUsage(entry.usage);
					} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
						addUsage(entry.usage);
					}
				}

				cachedLeaf = leafId;
				cachedTotals = totals;
				return totals;
			};

			return {
				dispose: () => {
					unsubscribe();
					if (refreshTimer) {
						clearTimeout(refreshTimer);
						refreshTimer = undefined;
					}
					if (refreshDirty === refresh) refreshDirty = undefined;
				},
				invalidate() {},

				render(width: number): string[] {
					const model = ctx.model;
					const totals = getTotals();
					const usage = ctx.getContextUsage();
					const settings = pi.getSettings();

					// Periodically refresh the dirty marker while the footer is visible.
					checkDirty(false);

					// --- left: ys-style path + git segment, then session/statuses ---
					const pwd = formatCwd(ctx.cwd);
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();

					const statuses = footerData.getExtensionStatuses();
					const statusText =
						statuses.size > 0
							? Array.from(statuses.entries())
									.sort(([a], [b]) => a.localeCompare(b))
									.map(([, text]) => sanitizeStatus(text))
									.join(" ")
							: "";

					let left = theme.fg("warning", pwd);
					if (branch) {
						left += theme.fg("muted", " on ");
						left += theme.fg("border", "git:");
						left += theme.fg("success", branch);
						if (dirty) left += ` ${theme.fg("error", "✗")}`;
					}
					if (sessionName) left += `  ${theme.fg("dim", `• ${sessionName}`)}`;
					if (statusText) left += `  ${theme.fg("dim", statusText)}`;

					// --- right: token/cost/context stats ---
					const stats: string[] = [];
					if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.cacheHitRate !== undefined) {
						stats.push(`CH${totals.cacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

					const autoCompact = settings.compaction?.enabled !== false ? " (auto)" : "";
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const percent = usage?.percent ?? null;
					const contextText =
						percent === null
							? `?/${formatTokens(contextWindow)}${autoCompact}`
							: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}${autoCompact}`;
					const contextColored =
						percent !== null && percent > 90
							? theme.fg("error", contextText)
							: percent !== null && percent > 70
								? theme.fg("warning", contextText)
								: contextText;

					const right = [...stats.map((part) => theme.fg("dim", part)), contextColored].join(" ");

					// --- single line, stats right-aligned, truncate left first ---
					const gap = 2;
					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);

					if (leftWidth + gap + rightWidth <= width) {
						const padding = " ".repeat(width - leftWidth - rightWidth);
						return [left + padding + right];
					}

					const availableForLeft = width - rightWidth - gap;
					if (availableForLeft > 0) {
						const truncatedLeft = truncateToWidth(left, availableForLeft, theme.fg("dim", "..."));
						const padding = " ".repeat(
							Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth),
						);
						return [truncateToWidth(truncatedLeft + padding + right, width)];
					}

					// Very narrow: keep the stats, drop the cwd/status side.
					if (rightWidth <= width) {
						return [" ".repeat(width - rightWidth) + right];
					}
					return [truncateToWidth(right, width, theme.fg("dim", "..."))];
				},
			};
		});
	});
}
