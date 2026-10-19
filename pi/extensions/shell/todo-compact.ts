/**
 * Compact todo overlay.
 *
 * `rpiv-todo` draws its task panel above the input box as a multi-row list that
 * stays expanded until `ctrl+shift+t` is pressed. For a list you mostly read as
 * "what is happening right now" that is a lot of chrome sitting on top of the
 * editor.
 *
 * This extension takes over the same widget key (`rpiv-todos`) and draws one
 * line instead:
 *
 *   ● Todos 2/7 · ◐ Create DemoTodoRepository (creating the repo)
 *
 * Clicking the line (fullscreen mode, the default) or pressing `alt+t` expands
 * it into the full task list; the same two gestures collapse it again. The
 * collapsed line carries the heading, the in-progress task (or the first
 * pending one), and the counts, so nothing has to be opened to see where the
 * run stands.
 *
 * Why take over the key instead of adding a second widget: rpiv-todo keeps its
 * task state private to its own module, so a companion panel could not read it,
 * and two panels showing the same list would be worse than one. The list is
 * replayed from the same two branch sources rpiv-todo persists — custom
 * `rpiv-todo-state` entries and `todo` tool-result `details` — so no state is
 * duplicated and nothing extra is written to the session.
 *
 * rpiv-todo still owns the `todo` tool, `/todos`, and its own shortcuts; only
 * the widget rendering is replaced. Its handlers for the same events run first
 * (this workspace is loaded after the npm packages), and the widget is
 * re-registered on every refresh, so the compact panel wins the shared key.
 *
 * Display-only: nothing here affects the session or the LLM context.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeyId,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";

/** Widget key owned by rpiv-todo; reusing it replaces that panel. */
const WIDGET_KEY = "rpiv-todos";
/** Keyboard fallback: clicks never reach the component outside fullscreen mode. */
const TOGGLE_KEY = "alt+t" as KeyId;

/** Persistence keys owned by rpiv-todo (see its `state/replay.ts`). */
const TOOL_NAME = "todo";
const STATE_ENTRY_TYPE = "rpiv-todo-state";

/** Expanded panels stop after this many task rows and summarize the rest. */
const MAX_EXPANDED_ROWS = 20;

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface TodoTask {
	id: number;
	subject: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
}

interface TodoSnapshot {
	tasks: TodoTask[];
	nextId: number;
}

interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

const STATUSES: ReadonlySet<string> = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

/** Drop control characters and escape sequences so a subject cannot recolor the line. */
function sanitize(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function asTask(value: unknown): TodoTask | undefined {
	if (!value || typeof value !== "object") return undefined;
	const task = value as Partial<TodoTask>;
	if (typeof task.id !== "number" || typeof task.subject !== "string") return undefined;
	if (typeof task.status !== "string" || !STATUSES.has(task.status)) return undefined;
	return { ...task, id: task.id, subject: task.subject, status: task.status };
}

/** Defensive decode of a persisted snapshot; unknown shapes are ignored. */
function asSnapshot(value: unknown): TodoSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const snapshot = value as { tasks?: unknown; nextId?: unknown };
	if (!Array.isArray(snapshot.tasks) || typeof snapshot.nextId !== "number") return undefined;
	// Rows that do not decode (older or future formats) are dropped rather than
	// discarding the whole list.
	const tasks = snapshot.tasks.map(asTask).filter((task): task is TodoTask => task !== undefined);
	return { tasks, nextId: snapshot.nextId };
}

/**
 * Last-write-wins replay over the current branch, mirroring rpiv-todo: custom
 * `rpiv-todo-state` entries are authoritative once the branch has any, and
 * `todo` tool-result details cover sessions written before those entries
 * existed.
 */
function replayTodos(ctx: ExtensionContext): TodoSnapshot {
	let fromEntries: TodoSnapshot | undefined;
	let fromResults: TodoSnapshot | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom") {
			if (entry.customType !== STATE_ENTRY_TYPE) continue;
			fromEntries = asSnapshot(entry.data) ?? fromEntries;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		fromResults = asSnapshot(message.details) ?? fromResults;
	}
	return fromEntries ?? fromResults ?? { tasks: [], nextId: 1 };
}

function countTasks(tasks: readonly TodoTask[]): TodoCounts {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const task of tasks) {
		if (task.status === "pending") pending++;
		else if (task.status === "in_progress") inProgress++;
		else if (task.status === "completed") completed++;
	}
	return { total: pending + inProgress + completed, pending, inProgress, completed };
}

function statusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/** `● Todos 2/7`, dimmed once every task is completed. */
function heading(theme: Theme, counts: TodoCounts): string {
	const active = counts.pending + counts.inProgress > 0;
	const color = active ? "accent" : "dim";
	return `${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, `Todos ${counts.completed}/${counts.total}`)}`;
}

/** One task row, matching rpiv-todo's glyph/color vocabulary. */
function taskRow(task: TodoTask, theme: Theme, showIds: boolean): string {
	const subjectColor =
		task.status === "in_progress" ? "accent" : task.status === "completed" || task.status === "deleted" ? "muted" : "text";
	let subject = theme.fg(subjectColor, sanitize(task.subject));
	if (task.status === "completed" || task.status === "deleted") subject = theme.strikethrough(subject);

	let line = statusGlyph(task.status, theme);
	if (showIds) line += ` ${theme.fg("dim", `#${task.id}`)}`;
	line += ` ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("muted", `(${sanitize(task.activeForm)})`)}`;
	}
	if (task.blockedBy && task.blockedBy.length > 0) {
		line += ` ${theme.fg("muted", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

/** The single collapsed line: heading plus the task currently being worked on. */
function renderCompactLine(theme: Theme, tasks: readonly TodoTask[], width: number): string {
	const counts = countTasks(tasks);
	const current = tasks.find((task) => task.status === "in_progress") ?? tasks.find((task) => task.status === "pending");

	let line = heading(theme, counts);
	if (current) {
		const subject = theme.fg(current.status === "in_progress" ? "accent" : "text", sanitize(current.subject));
		line += `${theme.fg("dim", " · ")}${statusGlyph(current.status, theme)} ${subject}`;
		if (current.status === "in_progress" && current.activeForm) {
			line += ` ${theme.fg("muted", `(${sanitize(current.activeForm)})`)}`;
		}
	}
	return truncateToWidth(line, width, "…");
}

/** The expanded panel: heading, every task, and the collapse hint. */
function renderExpanded(theme: Theme, tasks: readonly TodoTask[], width: number, hint: string): string[] {
	const counts = countTasks(tasks);
	const showIds = tasks.some((task) => task.blockedBy && task.blockedBy.length > 0);
	const rows = tasks.slice(0, MAX_EXPANDED_ROWS);

	const lines = [truncateToWidth(heading(theme, counts), width, "…")];
	for (const task of rows) {
		lines.push(truncateToWidth(`${theme.fg("dim", "├─")} ${taskRow(task, theme, showIds)}`, width, "…"));
	}
	if (tasks.length > rows.length) {
		lines.push(truncateToWidth(`${theme.fg("dim", "├─")} ${theme.fg("dim", `+${tasks.length - rows.length} more`)}`, width, "…"));
	}
	lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`, width, "…"));
	// Breathing room between the panel and the input box (the widget host only
	// adds a leading spacer).
	lines.push("");
	return lines;
}

class CompactTodoOverlay implements Component {
	constructor(
		private readonly getSnapshot: () => TodoSnapshot,
		private readonly isCollapsed: () => boolean,
		private readonly onToggle: () => void,
		private readonly getTheme: () => Theme,
		private readonly isFullscreen: () => boolean,
	) {}

	render(width: number): string[] {
		const theme = this.getTheme();
		const tasks = this.getSnapshot().tasks.filter((task) => task.status !== "deleted");
		if (tasks.length === 0) return [];

		const fullscreen = this.isFullscreen();
		if (this.isCollapsed()) return [renderCompactLine(theme, tasks, width)];

		const hint = fullscreen ? "click or alt+t to collapse" : "alt+t to collapse";
		return renderExpanded(theme, tasks, width, hint);
	}

	invalidate(): void {
		// Nothing rendered is cached; every render reads the live theme.
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.onToggle();
		return { handled: true, render: true };
	}
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let snapshot: TodoSnapshot = { tasks: [], nextId: 1 };
	let collapsed = true;
	let shown = false;
	let reassertTimer: ReturnType<typeof setTimeout> | undefined;

	const toggle = (): void => {
		collapsed = !collapsed;
		// Forced redraw: collapsing is a height change.
		tui?.requestRender(true);
	};

	/** (Re-)register the widget, or remove it when there is nothing to show. */
	const paint = (): void => {
		if (!ctx) return;
		const hasTasks = snapshot.tasks.some((task) => task.status !== "deleted");
		if (!hasTasks) {
			if (shown) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				shown = false;
				tui = undefined;
			}
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(nextTui, theme) => {
				tui = nextTui;
				return new CompactTodoOverlay(
					() => snapshot,
					() => collapsed,
					toggle,
					() => ctx?.ui.theme ?? theme,
					() => tui?.mode === "fullscreen",
				);
			},
			{ placement: "aboveEditor" },
		);
		shown = true;
	};

	const refresh = (nextCtx: ExtensionContext): void => {
		ctx = nextCtx;
		snapshot = replayTodos(nextCtx);
		paint();
	};

	/**
	 * Re-register after the current event loop turn.
	 *
	 * `session_start` is the one event where the order against rpiv-todo is not
	 * guaranteed by the event dispatch itself: its handler is async and loads the
	 * overlay module lazily, so if this workspace ever loaded first its widget
	 * registration would land on top of ours. A deferred re-assert costs one
	 * repaint once per session and makes the hand-off order-independent. (Every
	 * later refresh rides on `tool_result`, which rpiv-todo does not handle.)
	 */
	const reassertSoon = (): void => {
		if (reassertTimer) clearTimeout(reassertTimer);
		reassertTimer = setTimeout(() => {
			reassertTimer = undefined;
			paint();
		}, 0);
	};

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Collapse or expand the todo list",
		handler: (shortcutCtx) => {
			if (!shortcutCtx.hasUI) return;
			ctx = shortcutCtx;
			toggle();
		},
	});

	pi.on("session_start", (_event, sessionCtx) => {
		if (sessionCtx.mode !== "tui") return;
		refresh(sessionCtx);
		reassertSoon();
	});

	pi.on("session_compact", (_event, sessionCtx) => refresh(sessionCtx));
	pi.on("session_tree", (_event, sessionCtx) => refresh(sessionCtx));

	// Live update: the tool result carries the post-mutation snapshot, so no
	// branch read is needed (and the branch is not yet settled here anyway).
	pi.on("tool_result", (event, toolCtx) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		const next = asSnapshot(event.details);
		if (!next) return;
		ctx = toolCtx;
		snapshot = next;
		paint();
	});

	pi.on("session_shutdown", () => {
		if (reassertTimer) clearTimeout(reassertTimer);
		reassertTimer = undefined;
		// Best-effort teardown: the ctx proxy can already be invalidated during
		// session replacement, in which case there is nothing left to remove.
		try {
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// stale ctx during teardown
		}
		ctx = undefined;
		tui = undefined;
		snapshot = { tasks: [], nextId: 1 };
		shown = false;
	});
}
