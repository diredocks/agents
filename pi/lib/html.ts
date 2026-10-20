/**
 * Dependency-free HTML to Markdown and html to plain text conversion.
 *
 * Pi extensions can only import its own bundled modules, so the turndown +
 * htmlparser2 stack OpenCode uses for `webfetch` is not available here. This
 * module keeps the same behaviour that matters for reading web pages: skip
 * script/style-ish subtrees, turn block elements into blank-line separated
 * blocks, keep code blocks verbatim behind fences, and resolve relative links
 * against the fetched URL.
 *
 * It is intentionally not a full HTML parser. Unbalanced or exotic markup can
 * produce ragged output, which is fine for model-facing page text.
 */

const SKIP = new Set([
	"script",
	"style",
	"noscript",
	"iframe",
	"object",
	"embed",
	"svg",
	"canvas",
	"template",
	"video",
	"audio",
	"map",
	"math",
])

const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
])

const BLOCK = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"caption",
	"dd",
	"details",
	"dialog",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hgroup",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
])

const HEADING_LEVELS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	bull: "*",
	copy: "©",
	deg: "°",
	hellip: "…",
	laquo: "«",
	ldquo: "“",
	lsquo: "‘",
	lt: "<",
	mdash: "—",
	middot: "·",
	nbsp: " ",
	ndash: "–",
	quot: '"',
	raquo: "»",
	rdquo: "”",
	reg: "®",
	rsquo: "’",
	gt: ">",
	trade: "™",
	times: "×",
}

const TAG_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^>"'])*>/g
const ATTR_PATTERN = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

type Token =
	| { kind: "text"; value: string }
	| { kind: "comment" }
	| { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
	| { kind: "close"; name: string }

function decodeEntities(value: string): string {
	if (!value.includes("&")) return value
	return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
		if (body.startsWith("#")) {
			const code =
				body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
			return String.fromCodePoint(code)
		}
		const named = NAMED_ENTITIES[body.toLowerCase()]
		return named ?? match
	})
}

function parseAttrs(source: string): Record<string, string> {
	const attrs: Record<string, string> = {}
	ATTR_PATTERN.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = ATTR_PATTERN.exec(source))) {
		attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
	}
	return attrs
}

function tokenize(html: string, visit: (token: Token) => void): void {
	TAG_PATTERN.lastIndex = 0
	let index = 0
	let match: RegExpExecArray | null
	while ((match = TAG_PATTERN.exec(html))) {
		if (match.index > index) visit({ kind: "text", value: html.slice(index, match.index) })
		index = match.index + match[0].length
		const raw = match[0]
		const name = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(raw)?.[1]
		if (!name) {
			visit({ kind: "comment" })
			continue
		}
		if (raw.startsWith("</")) {
			visit({ kind: "close", name: name.toLowerCase() })
			continue
		}
		visit({
			kind: "open",
			name: name.toLowerCase(),
			attrs: parseAttrs(raw.slice(raw.indexOf(name) + name.length, raw.lastIndexOf(">"))),
			selfClosing: /\/\s*>$/.test(raw),
		})
	}
	if (index < html.length) visit({ kind: "text", value: html.slice(index) })
}

function resolveUrl(value: string, base?: string): string | undefined {
	const trimmed = value.trim().replace(/\s+/g, "")
	if (!trimmed || trimmed.startsWith("#") || /^javascript:/i.test(trimmed)) return undefined
	if (!base) return trimmed
	try {
		return new URL(trimmed, base).toString()
	} catch {
		return trimmed
	}
}

function longestRun(value: string, char: string): number {
	let longest = 0
	let current = 0
	for (const candidate of value) {
		current = candidate === char ? current + 1 : 0
		if (current > longest) longest = current
	}
	return longest
}

function langFromClass(attrs: Record<string, string>): string {
	const match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attrs.class ?? "")
	return match?.[1] ?? ""
}

/**
 * Collects Markdown without trailing blank lines. Block breaks are lazy: they
 * are only materialised when the next piece of content arrives, so closing tags
 * never leave dangling newlines.
 */
class MarkdownWriter {
	private buffer = ""
	private pending = 0
	private space = false
	private quotes = 0
	private lists: Array<{ ordered: boolean; index: number }> = []
	private open: Array<number | null> = []
	private items: Array<{ start: number; content: number; list: { ordered: boolean; index: number } | undefined }> = []

	text(value: string): void {
		if (!value) return
		if (!value.trim()) {
			this.space = true
			return
		}
		const collapsed = value.replace(/\s+/g, " ")
		const leading = this.space || collapsed.startsWith(" ")
		this.flush()
		const needsSpace = leading && this.buffer !== "" && !/\s$/.test(this.buffer)
		this.buffer += (needsSpace ? " " : "") + collapsed.trim()
		this.space = collapsed.endsWith(" ")
	}

	/** Append literal Markdown that should not be whitespace-collapsed. */
	write(value: string): void {
		const space = this.space && this.pending === 0
		this.flush()
		if (space && this.buffer !== "" && !/\s$/.test(this.buffer)) this.buffer += " "
		this.buffer += value
	}

	block(level = 2): void {
		// Paragraph breaks inside a list item would split the marker from its text;
		// keep items on one line instead.
		if (level > 1 && this.lists.length > 0 && this.onItemLine()) return
		this.pending = Math.max(this.pending, level)
	}

	/** Force a single line break now, so following output starts on a new line. */
	line(): void {
		this.block(1)
		this.flush()
	}

	quote(delta: number): void {
		this.quotes += delta
		if (this.quotes < 0) this.quotes = 0
	}

	list(ordered: boolean): void {
		this.lists.push({ ordered, index: 0 })
	}

	endList(): void {
		this.lists.pop()
	}

	listItem(): void {
		this.block(1)
		this.flush()
		const list = this.lists[this.lists.length - 1]
		const indent = "  ".repeat(Math.max(0, this.lists.length - 1))
		const start = this.buffer.length
		this.buffer += indent + (list?.ordered ? `${++list.index}. ` : "- ")
		this.items.push({ start, content: this.buffer.length, list })
	}

	/** Drop the marker again when the item only contained an icon or other ignored markup. */
	endListItem(): void {
		const item = this.items.pop()
		if (!item || this.buffer.slice(item.content).trim() !== "") return
		// Keep the line break that `listItem()` inserted before the marker.
		this.buffer = this.buffer.slice(0, item.start)
		if (item.list) item.list.index--
	}

	begin(): void {
		this.open.push(this.buffer.length)
	}

	end(prefix: string, suffix: string): void {
		const start = this.open.pop()
		if (start === undefined || start === null || start > this.buffer.length) return
		const inner = this.buffer.slice(start)
		const core = inner.trim()
		if (!core) return
		const leading = inner.slice(0, inner.indexOf(core))
		const trailing = inner.slice(inner.indexOf(core) + core.length)
		this.buffer = this.buffer.slice(0, start) + leading + prefix + core + suffix + trailing
	}

	toString(): string {
		return this.buffer.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trimEnd()
	}

	private onItemLine(): boolean {
		return /^\s*(?:[-*]|\d+\.)\s/.test(this.buffer.slice(this.buffer.lastIndexOf("\n") + 1))
	}

	private flush(): void {
		const level = this.pending
		this.pending = 0
		this.space = false
		if (level === 0) return
		// Any newline invalidates inline spans recorded before it.
		for (let i = 0; i < this.open.length; i++) this.open[i] = null
		const trimmed = this.buffer.replace(/[ \t]+$/, "")
		if (!trimmed) {
			this.buffer = ""
			return
		}
		const existing = /\n+$/.exec(trimmed)?.[0].length ?? 0
		if (existing >= level) {
			this.buffer = trimmed
			return
		}
		this.buffer = trimmed + "\n".repeat(level - existing) + "> ".repeat(this.quotes)
	}
}

function writeCodeBlock(writer: MarkdownWriter, code: { lang: string; text: string }): void {
	const text = code.text.replace(/^\n+/, "").replace(/\s+$/, "")
	const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1))
	writer.block(2)
	writer.write(`${fence}${code.lang}\n${text}\n${fence}`)
	writer.block(2)
}

export function htmlToMarkdown(html: string, baseUrl?: string): string {
	const writer = new MarkdownWriter()
	let skip = 0
	let pre: { lang: string; text: string } | undefined
	let table: { rows: number; columns: number } | undefined
	const links: Array<string | undefined> = []

	tokenize(html, (token) => {
		if (token.kind === "comment") return
		if (token.kind === "text") {
			if (skip > 0) return
			if (pre) {
				pre.text += decodeEntities(token.value)
				return
			}
			writer.text(decodeEntities(token.value))
			return
		}

		const name = token.name
		const opened = token.kind === "open"

		if (SKIP.has(name)) {
			if (token.kind === "close") skip = Math.max(0, skip - 1)
			else if (!token.selfClosing && !VOID.has(name)) skip++
			return
		}
		if (skip > 0) return

		// Inside <pre> only the <code> language hint is interesting.
		if (pre && name !== "pre") {
			if (opened && name === "code" && !pre.lang) pre.lang = langFromClass(token.attrs)
			return
		}

		if (name === "pre") {
			if (opened) pre = { lang: "", text: "" }
			else if (pre) {
				writeCodeBlock(writer, pre)
				pre = undefined
			}
			return
		}

		const level = HEADING_LEVELS[name]
		if (level) {
			if (opened) {
				writer.block(2)
				writer.write(`${"#".repeat(level)} `)
			} else {
				writer.block(2)
			}
			return
		}

		switch (name) {
			case "br":
				writer.line()
				return
			case "hr":
				writer.block(2)
				writer.write("---")
				writer.block(2)
				return
			case "p":
			case "div":
			case "section":
			case "article":
			case "aside":
			case "header":
			case "footer":
			case "main":
			case "nav":
			case "figure":
			case "figcaption":
			case "dl":
			case "dt":
			case "dd":
			case "address":
				writer.block(2)
				return
			case "blockquote":
				if (opened) {
					writer.block(2)
					writer.quote(1)
				} else {
					writer.quote(-1)
					writer.block(2)
				}
				return
			case "ul":
			case "ol":
				if (opened) writer.list(name === "ol")
				else {
					writer.endList()
					writer.block(2)
				}
				return
			case "li":
				if (opened) writer.listItem()
				else {
					writer.endListItem()
					writer.block(1)
				}
				return
			case "a":
				if (opened) {
					links.push(resolveUrl(token.attrs.href ?? "", baseUrl))
					writer.begin()
				} else {
					const href = links.pop()
					if (href) writer.end("[", `](${href})`)
					else writer.end("", "")
				}
				return
			case "img":
				if (opened && !token.attrs.src?.startsWith("data:")) {
					const src = resolveUrl(token.attrs.src ?? "", baseUrl)
					if (src) writer.write(`![${decodeEntities(token.attrs.alt ?? "")}](${src})`)
				}
				return
			case "strong":
			case "b":
				if (opened) writer.begin()
				else writer.end("**", "**")
				return
			case "em":
			case "i":
				if (opened) writer.begin()
				else writer.end("*", "*")
				return
			case "del":
			case "s":
			case "strike":
				if (opened) writer.begin()
				else writer.end("~~", "~~")
				return
			case "code":
				if (opened) writer.begin()
				else writer.end("`", "`")
				return
			case "table":
				if (opened) {
					table = { rows: 0, columns: 0 }
					writer.block(2)
				} else {
					table = undefined
					writer.block(2)
				}
				return
			case "thead":
			case "tbody":
			case "tfoot":
				if (!opened) writer.block(1)
				return
			case "tr":
				if (opened) {
					writer.line()
					if (table) table.columns = 0
				} else if (table) {
					writer.write(" |")
					writer.line()
					if (table.rows === 0) {
						writer.write(`|${" --- |".repeat(table.columns)}`)
						writer.line()
					}
					table.rows++
				}
				return
			case "td":
			case "th":
				if (opened) {
					if (table) table.columns++
					writer.write(table && table.columns > 1 ? " | " : "| ")
				}
				return
			default:
				return
		}
	})

	return writer.toString()
}

export function htmlToText(html: string): string {
	let text = ""
	let skip = 0
	let pre = false

	tokenize(html, (token) => {
		if (token.kind === "comment") return
		if (token.kind === "text") {
			if (skip > 0) return
			text += pre ? decodeEntities(token.value) : decodeEntities(token.value).replace(/\s+/g, " ")
			return
		}

		const name = token.name
		const opened = token.kind === "open"

		if (SKIP.has(name)) {
			if (token.kind === "close") skip = Math.max(0, skip - 1)
			else if (!token.selfClosing && !VOID.has(name)) skip++
			return
		}
		if (skip > 0) return

		if (name === "pre") {
			pre = opened
			text += "\n"
			return
		}
		if (name === "br" || name === "hr") {
			text += "\n"
			return
		}
		if (!BLOCK.has(name)) return
		text += "\n"
	})

	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}
