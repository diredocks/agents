/**
 * Web search and provider-side page fetching over pi's built-in MCP support.
 *
 * Both Exa and Parallel expose plain streamable-HTTP MCP endpoints, so the
 * extension only has to register one of them: pi owns the protocol (initialize
 * handshake, SSE replies, retries on transient HTTP errors, reconnects), keeps
 * the tool schemas in sync with what the server actually accepts, and applies
 * its own result truncation. The server's tools are declared to the model
 * (`direct` exposure) rather than hidden behind `tool_search`.
 *
 * Registered tools, depending on the provider:
 *   mcp__exa__web_search_exa / mcp__exa__web_fetch_exa
 *   mcp__parallel__web_search / mcp__parallel__web_fetch
 *
 * The local `webfetch` tool in this workspace stays independent of these: it
 * reads any URL without sending it to a third party.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const EXA_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_URL = "https://search.parallel.ai/mcp"

type Provider = "exa" | "parallel"

/**
 * Parallel needs an API key and Exa's public endpoint works without one, so a
 * configured Parallel key is the only signal worth reading.
 * `PI_WEBSEARCH_PROVIDER` exists for poking at a single provider by hand.
 */
function selectProvider(env: NodeJS.ProcessEnv): Provider {
	if (env.PI_WEBSEARCH_PROVIDER === "exa" || env.PI_WEBSEARCH_PROVIDER === "parallel") {
		return env.PI_WEBSEARCH_PROVIDER
	}
	return env.PARALLEL_API_KEY ? "parallel" : "exa"
}

export default function webSearch(pi: ExtensionAPI): void {
	const env = process.env
	const provider = selectProvider(env)

	if (provider === "parallel") {
		pi.registerMcpServer("parallel", {
			url: PARALLEL_URL,
			exposure: "direct",
			timeout: 30,
			description: "Parallel web search and page fetch for current information.",
			headers: env.PARALLEL_API_KEY ? { Authorization: `Bearer ${env.PARALLEL_API_KEY}` } : undefined,
		})
		return
	}

	pi.registerMcpServer("exa", {
		url: env.EXA_API_KEY ? `${EXA_URL}?exaApiKey=${encodeURIComponent(env.EXA_API_KEY)}` : EXA_URL,
		exposure: "direct",
		timeout: 30,
		description: "Exa web search and page fetch for current information.",
	})
}
