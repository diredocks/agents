/**
 * `webfetch` tool: download a URL and return it as markdown, text, or HTML.
 *
 * Modelled on OpenCode's `webfetch` tool:
 * - per-format `Accept` headers with q-value fallbacks and a Chrome user agent
 * - retry with an honest user agent when Cloudflare answers a 403 challenge,
 *   because the browser UA no longer matches this client's TLS fingerprint
 * - 5 MB response cap, 30 second default timeout, 120 second ceiling
 * - HTML is converted to markdown/tables/code fences locally, images are
 *   returned as image content for the model
 * - the full text goes to a temp file whenever the model-facing preview is
 *   truncated
 */

import { Type, type Static } from "typebox"
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	VERSION,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateHead,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { htmlToMarkdown, htmlToText } from "../../lib/html.ts"
import { boundOutput } from "../../lib/tool-output.ts"

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

type Format = "text" | "markdown" | "html"

interface FetchDetails {
	url: string
	contentType: string
	format: Format
	bytes: number
	image?: boolean
	truncated?: boolean
	outputPath?: string
}

const parameters = Type.Object({
	url: Type.String({ description: "The HTTP or HTTPS URL to fetch" }),
	format: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
			description: "Return format: markdown (default), text, or html",
			default: "markdown",
		}),
	),
	timeout: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
			description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS})`,
		}),
	),
})

function acceptHeader(format: Format): string {
	switch (format) {
		case "markdown":
			return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
		case "text":
			return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
		case "html":
			return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
	}
}

function describe(error: unknown): string | undefined {
	if (error instanceof AggregateError) {
		const parts = error.errors.map(describe).filter((part): part is string => Boolean(part))
		return parts.join("; ") || error.message || undefined
	}
	if (error instanceof Error) return error.message || (error as NodeJS.ErrnoException).code
	return undefined
}

function failure(error: unknown, timeoutMs: number, signal: AbortSignal | undefined): Error {
	if (signal?.aborted) return new Error("Request aborted")
	if (error instanceof DOMException && error.name === "TimeoutError") {
		return new Error(`Request timed out after ${timeoutMs / 1000}s`)
	}
	const cause = error instanceof Error ? error.cause : undefined
	return new Error(`Request failed: ${describe(cause) ?? describe(error) ?? "unknown error"}`)
}

async function send(
	url: string,
	format: Format,
	userAgent: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs)
	try {
		return await fetch(url, {
			headers: {
				"User-Agent": userAgent,
				Accept: acceptHeader(format),
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		})
	} catch (error) {
		throw failure(error, timeoutMs, signal)
	}
}

function decodeBody(body: ArrayBuffer, contentType: string): string {
	const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1]?.trim()
	try {
		return new TextDecoder(charset ?? "utf-8").decode(body)
	} catch {
		return new TextDecoder().decode(body)
	}
}

function isTextual(mime: string): boolean {
	return (
		!mime ||
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime.endsWith("+json") ||
		mime === "application/xml" ||
		mime.endsWith("+xml") ||
		mime === "application/javascript" ||
		mime === "application/x-javascript" ||
		mime === "application/x-www-form-urlencoded" ||
		mime === "application/sql"
	)
}

function renderCall(args: Static<typeof parameters>, theme: Theme) {
	let text = theme.fg("toolTitle", theme.bold("webfetch "))
	text += theme.fg("accent", args.url)
	if (args.format && args.format !== "markdown") text += theme.fg("dim", ` as ${args.format}`)
	return new Text(text, 0, 0)
}

function renderResult(
	result: AgentToolResult<FetchDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
) {
	const details = result.details
	if (options.isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0)
	if (!details) return new Text(theme.fg("dim", "No response"), 0, 0)

	let text = details.image
		? theme.fg("success", `image ${details.contentType || "unknown type"} (${formatSize(details.bytes)})`)
		: theme.fg("success", `${details.format} (${formatSize(details.bytes)})`)
	if (details.truncated) text += theme.fg("warning", " (truncated)")
	if (details.outputPath) text += `\n${theme.fg("dim", `full output: ${details.outputPath}`)}`

	if (options.expanded) {
		const body = result.content.find((item) => item.type === "text")?.text
		if (body) {
			const preview = truncateHead(body, { maxLines: 60, maxBytes: 4 * 1024 }).content
			for (const line of preview.split("\n")) text += `\n${theme.fg("toolOutput", line)}`
		}
	}
	return new Text(text, 0, 0)
}

export const webFetchTool: ToolDefinition<typeof parameters, FetchDetails> = {
	name: "webfetch",
	label: "Web Fetch",
	description: `Fetch a URL and return its content as markdown (default), text, or HTML.

Use this to read documentation, articles, changelogs, or any page the user points at. Relative links and images in HTML are resolved against the fetched URL, scripts and styles are dropped, and code blocks keep their fences.

Limits: 5 MB responses, ${DEFAULT_TIMEOUT_SECONDS}s default timeout (max ${MAX_TIMEOUT_SECONDS}s). Large pages are truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete output is then saved to a temp file whose path is reported in the result.

Use webfetch when you already know the URL and want it fetched locally. If a page is JavaScript-rendered, bot-protected, or comes back as an empty shell, retry it with the provider fetch tool when one is available (mcp__exa__web_fetch_exa or mcp__parallel__web_fetch), which crawls server-side. Use the provider search tool (mcp__exa__web_search_exa or mcp__parallel__web_search) when you need to discover URLs.`,
	promptSnippet: "Fetch a URL locally and return it as markdown, text, or HTML",
	promptGuidelines: [
		"Prefer webfetch over shell curl/wget for reading web pages so the content is converted for you",
		"Fall back to a provider MCP fetch tool for pages that need JavaScript or block direct fetches",
	],
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
	parameters,

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		let url: URL
		try {
			url = new URL(params.url)
		} catch {
			throw new Error(`Invalid URL: ${params.url}`)
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("URL must start with http:// or https://")
		}

		const format: Format = params.format ?? "markdown"
		const timeoutMs = Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000

		const initial = await send(url.toString(), format, BROWSER_UA, timeoutMs, signal)
		const response =
			initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
				? await send(url.toString(), format, `pi/${VERSION}`, timeoutMs, signal)
				: initial
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.toString()}`)

		const declaredLength = Number(response.headers.get("content-length") ?? 0)
		if (declaredLength > MAX_RESPONSE_BYTES) {
			throw new Error(`Response too large (${formatSize(declaredLength)} exceeds ${formatSize(MAX_RESPONSE_BYTES)})`)
		}
		const body = await response.arrayBuffer()
		if (body.byteLength > MAX_RESPONSE_BYTES) {
			throw new Error(`Response too large (${formatSize(body.byteLength)} exceeds ${formatSize(MAX_RESPONSE_BYTES)})`)
		}

		const contentType = response.headers.get("content-type") ?? ""
		const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase()
		const details: FetchDetails = { url: url.toString(), contentType, format, bytes: body.byteLength }

		if (mime.startsWith("image/") && mime !== "image/svg+xml") {
			return {
				content: [
					{ type: "text", text: `Fetched image ${url.toString()} (${mime}, ${formatSize(body.byteLength)})` },
					{ type: "image", data: Buffer.from(body).toString("base64"), mimeType: mime },
				],
				details: { ...details, image: true },
			}
		}
		if (!isTextual(mime)) throw new Error(`Unsupported content type: ${mime || "unknown"}`)

		const raw = decodeBody(body, contentType)
		const html = /html/i.test(contentType)
		const converted =
			format === "html" || !html ? raw : format === "markdown" ? htmlToMarkdown(raw, url.toString()) : htmlToText(raw)

		const bounded = converted.length === 0 ? { text: "(empty response body)" } : await boundOutput("webfetch", converted)

		return {
			content: [{ type: "text", text: bounded.text }],
			details: {
				...details,
				truncated: bounded.truncation?.truncated,
				outputPath: bounded.outputPath,
			},
		}
	},

	renderCall,
	renderResult,
}

export default function webFetch(pi: ExtensionAPI): void {
	pi.registerTool(webFetchTool)
}
