/**
 * Shared output handling for the web tools: keep model-facing text inside the
 * standard truncation budget and write the complete output somewhere the model
 * can read later.
 */

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent"

export const OUTPUT_DIR = join(tmpdir(), "pi", "web")

export interface BoundedOutput {
	text: string
	truncation?: TruncationResult
	outputPath?: string
}

export async function boundOutput(kind: string, content: string): Promise<BoundedOutput> {
	const truncation = truncateHead(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
	if (!truncation.truncated) return { text: truncation.content }

	const hash = createHash("sha1").update(content).digest("hex").slice(0, 8)
	const outputPath = join(OUTPUT_DIR, `${kind}-${hash}.md`)
	await mkdir(OUTPUT_DIR, { recursive: true })
	await withFileMutationQueue(outputPath, () => writeFile(outputPath, content, "utf8"))

	const omittedLines = truncation.totalLines - truncation.outputLines
	const omittedBytes = truncation.totalBytes - truncation.outputBytes
	return {
		text: `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}), ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to ${outputPath}]`,
		truncation,
		outputPath,
	}
}
