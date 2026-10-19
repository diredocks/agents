/**
 * Compact ask_user_question transcript rendering.
 *
 * `rpiv-ask-user-question` registers its tool without `renderCall`/`renderResult`,
 * so Pi falls back to `formatToolCallWithArgs`: the whole `{ questions: [...] }`
 * argument tree is dumped as JSON, and the result prints the long
 * "User has answered your questions: ..." envelope sentence. That is a lot of
 * prose for something you only ever scan for "what did I end up choosing".
 *
 * This extension registers tool renderers for `ask_user_question` only (through
 * `pi.registerToolRenderer`, so the npm package stays untouched) and draws a
 * compact row instead:
 *
 *   ask_user_question · 2 questions
 *   Which database?   PostgreSQL
 *   Which ORM?        Drizzle
 *
 * The call line carries the question count while the questionnaire is open; the
 * result lists every question next to the answer it got, aligned in one column.
 * Cancelled, failed, and partially answered questionnaires each get their own
 * short marker. Expanding the row (`ctrl+e` / click) adds the authored options
 * to the call and notes, previews, and the raw envelope to the result.
 *
 * Display-only: nothing here changes the questionnaire, the session, or the LLM
 * context.
 */

import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Tool name owned by `@juicesharp/rpiv-ask-user-question`. */
const TOOL_NAME = "ask_user_question";

/** Longest question column before it is ellipsized; keeps the answer column readable. */
const MAX_QUESTION_WIDTH = 44;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface AskOption {
	label?: string;
	description?: string;
	preview?: string;
}

interface AskQuestion {
	question: string;
	header?: string;
	options?: AskOption[];
	multiSelect?: boolean;
}

interface AskAnswer {
	questionIndex?: number;
	question?: string;
	kind?: "option" | "custom" | "multi";
	answer?: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

interface AskDetails {
	answers?: AskAnswer[];
	cancelled?: boolean;
	globalNote?: string;
	unanswered?: number[];
	error?: string;
}

/** Context type is not re-exported; derive it from the renderer signature. */
type AskRenderCall = NonNullable<ToolRenderers["renderCall"]>;
type AskRenderResult = NonNullable<ToolRenderers["renderResult"]>;
type AskContext = Parameters<AskRenderCall>[2];
type AskResult = Parameters<AskRenderResult>[0];

/* ------------------------------------------------------------------ */
/* Decoding                                                             */
/* ------------------------------------------------------------------ */

function asQuestions(args: unknown): AskQuestion[] {
	if (!args || typeof args !== "object") return [];
	const questions = (args as { questions?: unknown }).questions;
	if (!Array.isArray(questions)) return [];
	return questions.filter(
		(question): question is AskQuestion =>
			!!question && typeof question === "object" && typeof (question as AskQuestion).question === "string",
	);
}

function asDetails(value: unknown): AskDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = value as AskDetails;
	if (!Array.isArray(details.answers) && typeof details.cancelled !== "boolean") return undefined;
	return details;
}

/** Single line: collapse every control character (newlines included) to a space. */
function sanitizeLine(text: unknown): string {
	return typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ") : "";
}

/** Multi-line: keep newlines, neutralize the rest. */
function sanitizeLines(text: string): string[] {
	return text.split(/\r?\n/).map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, " "));
}

/** The model-facing envelope text, when present. */
function rawText(result: AskResult | undefined): string | undefined {
	const content = (result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

/** Mirror `format-answer.ts`'s scalar form: selected labels plus optional custom text. */
function formatAnswer(answer: AskAnswer): string {
	if (answer.kind === "multi") {
		const values = [...(answer.selected ?? [])];
		if (answer.answer) values.push(answer.answer);
		return values.length > 0 ? values.join(", ") : "(no input)";
	}
	return answer.answer && answer.answer.length > 0 ? answer.answer : "(no input)";
}

/* ------------------------------------------------------------------ */
/* Call rendering                                                       */
/* ------------------------------------------------------------------ */

function renderCall(args: unknown, theme: Theme, context: AskContext): Component {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const questions = asQuestions(args);

	let line = theme.fg("toolTitle", theme.bold(TOOL_NAME));
	line += theme.fg("muted", ` · ${questions.length} question${questions.length === 1 ? "" : "s"}`);
	// Arguments stream in as `{}` first; the count is not final until they settle.
	if (questions.length === 0 && !context.argsComplete) line += theme.fg("dim", " …");

	const lines = [line];
	if (context.expanded) {
		for (const question of questions) {
			const header = sanitizeLine(question.header);
			const label = `${header ? `${header}: ` : ""}${sanitizeLine(question.question)}`;
			lines.push(theme.fg("dim", `  ${label}${question.multiSelect ? theme.fg("muted", " [multi]") : ""}`));
			for (const option of question.options ?? []) {
				if (typeof option?.label !== "string") continue;
				lines.push(theme.fg("muted", `    - ${sanitizeLine(option.label)}`));
			}
		}
	}

	text.setText(lines.join("\n"));
	return text;
}

/* ------------------------------------------------------------------ */
/* Result rendering                                                     */
/* ------------------------------------------------------------------ */

interface AnswerRow {
	question: string;
	answer?: AskAnswer;
	unanswered: boolean;
}

/** Pair authored questions with the answers, then append any orphaned answers. */
function buildRows(questions: AskQuestion[], details: AskDetails): AnswerRow[] {
	const answers = details.answers ?? [];
	const byIndex = new Map<number, AskAnswer>();
	answers.forEach((answer, position) => {
		byIndex.set(typeof answer.questionIndex === "number" ? answer.questionIndex : position, answer);
	});
	const unanswered = new Set(details.unanswered ?? []);

	const rows: AnswerRow[] = questions.map((question, index) => ({
		question: question.question,
		answer: byIndex.get(index),
		unanswered: unanswered.has(index),
	}));
	// Defensive: an answer whose index outruns the authored list still shows up.
	for (const [index, answer] of byIndex) {
		if (index >= questions.length) rows.push({ question: answer.question ?? `Question ${index + 1}`, answer, unanswered: false });
	}
	// No author metadata (e.g. a resumed session): fall back to the answer's own question text.
	if (rows.length === 0) {
		for (const answer of answers) rows.push({ question: answer.question ?? "Question", answer, unanswered: false });
	}
	return rows;
}

function buildResultLines(
	result: AskResult | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AskContext,
): string[] {
	if (options.isPartial) return [theme.fg("dim", "waiting for answers…")];

	const details = asDetails((result as { details?: unknown } | undefined)?.details);
	const questions = asQuestions(context.args);

	// Failed to even ask (validation, no UI, load failure): name the reason.
	if (details?.error) {
		const lines = [theme.fg("error", `failed: ${sanitizeLine(details.error)}`)];
		if (options.expanded) {
			const raw = rawText(result);
			if (raw) lines.push(theme.fg("dim", raw));
		}
		return lines;
	}

	// Unknown result shape: show the raw envelope rather than nothing.
	if (!details) {
		const raw = rawText(result);
		return raw ? [theme.fg("toolOutput", raw)] : [];
	}

	if (details.cancelled && (details.answers ?? []).length === 0) {
		const lines = [theme.fg("dim", "declined")];
		if (details.globalNote) lines.push(theme.fg("muted", `global note: ${sanitizeLine(details.globalNote)}`));
		return lines;
	}

	const rows = buildRows(questions, details);
	if (rows.length === 0) return [];

	const labels = rows.map((row) => truncateToWidth(sanitizeLine(row.question), MAX_QUESTION_WIDTH, "…"));
	const column = Math.max(1, ...labels.map((label) => visibleWidth(label)));

	const lines: string[] = [];
	rows.forEach((row, index) => {
		const label = labels[index];
		const gap = " ".repeat(Math.max(1, column - visibleWidth(label) + 2));
		const value = row.answer
			? theme.fg("accent", sanitizeLine(formatAnswer(row.answer)))
			: theme.fg("dim", row.unanswered ? "unanswered" : "(no input)");
		lines.push(`${theme.fg("muted", label)}${gap}${value}`);

		if (!options.expanded || !row.answer) return;
		for (const note of sanitizeLines(row.answer.notes ?? "")) {
			if (note.length === 0) continue;
			lines.push(`${" ".repeat(column + 2)}${theme.fg("dim", "note: ")}${theme.fg("muted", note)}`);
		}
		if (row.answer.preview) {
			lines.push(`${" ".repeat(column + 2)}${theme.fg("dim", "selected preview:")}${theme.fg("muted", " …")}`);
		}
	});

	if (details.globalNote) lines.push(`${theme.fg("dim", "global note: ")}${theme.fg("muted", sanitizeLine(details.globalNote))}`);

	if (options.expanded) {
		const raw = rawText(result);
		if (raw) lines.push(theme.fg("dim", raw));
	}

	return lines;
}

function renderResult(
	result: AskResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: AskContext,
): Component {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(buildResultLines(result as AgentToolResult<unknown>, options, theme, context).join("\n"));
	return text;
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		// Every other tool keeps whatever the remaining resolvers / the tool itself
		// would draw. Returning `undefined` without `next()` would swallow them all,
		// because the resolver chain stops at the first non-`next()` return.
		if (toolName !== TOOL_NAME) return next();
		return { ...(next() ?? {}), renderCall, renderResult };
	});
}
