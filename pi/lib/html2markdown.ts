/**
 * HTML → Markdown conversion through the `html2markdown` CLI
 * (https://github.com/Johanneskaufmann/html-to-markdown).
 *
 * The binary is looked up on `PATH`. Plugins mirror what `webfetch` needs for
 * reading pages: tables and strikethrough, on top of the default CommonMark
 * rules (headings, lists, links, images, code fences, quotes). Scripts, styles,
 * `iframe`, and `noscript` are dropped by the converter; `<svg>` text is not.
 *
 * Relative links and images are resolved when a base URL is passed as
 * `--domain`. The CLI emits an `<!--THE END-->` sentinel between adjacent lists
 * so a Markdown renderer does not merge them; it is stripped here because the
 * output is read as text, never re-rendered.
 */

import { spawn } from "node:child_process"

const BIN = "html2markdown"
const PLUGINS = ["--plugin-table", "--plugin-strikethrough"]
const LIST_SENTINEL = /^<!--THE END-->[ \t]*\n?/gm

export interface ConvertOptions {
	/** Base URL used to turn relative links and image sources into absolute ones. */
	baseUrl?: string
	/** Aborts the child process. */
	signal?: AbortSignal
}

/**
 * Convert an HTML document to Markdown.
 *
 * @throws when the binary is missing or exits non-zero.
 */
export function htmlToMarkdown(html: string, options: ConvertOptions = {}): Promise<string> {
	const args = [...PLUGINS]
	if (options.baseUrl) args.push("--domain", options.baseUrl)

	return new Promise((resolve, reject) => {
		const child = spawn(BIN, args, { stdio: ["pipe", "pipe", "pipe"], signal: options.signal })
		let stdout = ""
		let stderr = ""

		child.stdout.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk
		})

		child.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "ENOENT" && !options.signal?.aborted
					? new Error(`\`${BIN}\` was not found on PATH; it is needed to convert HTML to markdown`)
					: error,
			)
		})

		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve(stdout.replace(LIST_SENTINEL, "").replace(/\n{3,}/g, "\n\n").trim())
				return
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`
			const detail = stderr.trim().split("\n")[0]
			reject(new Error(`\`${BIN}\` failed (${reason})${detail ? `: ${detail}` : ""}`))
		})

		// The child may exit before consuming stdin; that surfaces as EPIPE here.
		child.stdin.on("error", () => {})
		child.stdin.end(html)
	})
}
