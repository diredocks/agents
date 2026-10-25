/**
 * magpie provider for Pi — OpenAI Responses API only.
 *
 * magpie (https://github.com/yetone/magpie) runs a gateway that speaks OpenAI
 * Chat, OpenAI Responses, Anthropic Messages and Gemini, translating between
 * them per model. This extension registers one Pi provider that asks every
 * model on `/v1/responses`; magpie translates the models whose vendor speaks
 * Chat or Messages natively, tool calls and reasoning included.
 *
 * Setup, in Pi:
 *
 *   /login  -> "Sign in with an API key" -> magpie
 *     gateway URL   e.g. https://gateway.example.com   (a bare host gets /v1)
 *     gateway key   "magpie" on a loopback-only gateway, or a gateway key
 *
 *   /logout -> magpie      removes the stored URL and key
 *
 * The URL and key live in ~/.pi/agent/auth.json as this provider's api-key
 * credential; nothing is hardcoded here. `MAGPIE_URL` and
 * `MAGPIE_GATEWAY_KEY` in the environment work instead of /login (CI).
 *
 * Models come from magpie's `/v1/models`, which reports each model's window,
 * output limit, reasoning levels, modalities and price, so `/model` keeps up
 * with providers and routing groups without editing models.json.
 */

import {
	type Credential,
	type Model,
	type RefreshModelsContext,
	createProvider,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "magpie";
const ENV_URL = "MAGPIE_URL";
const ENV_KEY = "MAGPIE_GATEWAY_KEY";
/** magpie's own default when nothing is configured. */
const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";
/** A loopback gateway takes any key; this is the one magpie's docs use. */
const LOOPBACK_KEY = "magpie";

const DISCOVERY_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiLevel = (typeof PI_LEVELS)[number];
type Api = "openai-responses";

/** An entry of magpie's `/v1/models`; every field except `id` is optional. */
interface MagpieModel {
	id?: string;
	kind?: string;
	display_name?: string;
	reasoning?: boolean;
	reasoning_levels?: string[];
	supported_reasoning_levels?: { effort?: string }[];
	context_window?: number;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	modalities?: { input?: string[]; output?: string[] };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

interface Gateway {
	url: string;
	key: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider<Api>({
			id: PROVIDER_ID,
			name: "Magpie",
			models: [],
			api: openAIResponsesApi(),
			auth: {
				apiKey: {
					name: "Magpie gateway key",
					async login(interaction) {
						const ask = async (type: "text" | "secret", message: string, placeholder: string) =>
							(await interaction.prompt({ type, message, placeholder })).trim();

						const envUrl = normalizeBaseUrl(process.env[ENV_URL]);
						const url =
							normalizeBaseUrl(await ask("text", "magpie gateway URL", envUrl ?? DEFAULT_BASE_URL)) ??
							envUrl ??
							DEFAULT_BASE_URL;

						const fallbackKey = isLoopback(url) ? LOOPBACK_KEY : "";
						const key =
							(await ask("secret", "magpie gateway key", fallbackKey || "sk-magpie-…")) || fallbackKey;
						if (!key) throw new Error(`magpie: ${url} needs a gateway key`);

						// Check now, so a wrong URL or key fails in the dialog
						// instead of leaving a provider that silently lists nothing.
						await listModels({ url, key }, interaction.signal);
						return { type: "api_key", key, env: { [ENV_URL]: url } };
					},
					// No `check`: resolving is side-effect free here, so Pi's default
					// (configured when `resolve` returns something) is already right.
					async resolve({ ctx, credential }) {
						const gateway = await resolveGateway(credential, (name) => ctx.env(name));
						if (!gateway) return undefined;
						return {
							auth: { apiKey: gateway.key, baseUrl: gateway.url },
							env: { ...credential?.env, [ENV_URL]: gateway.url },
							source: credential ? "stored credential" : ENV_KEY,
						};
					},
				},
			},
			async fetchModels(context: RefreshModelsContext) {
				const gateway = await resolveGateway(context.credential, (name) => process.env[name]);
				if (!gateway) return [];
				return listModels(gateway, context.signal);
			},
		}),
	);
}

/**
 * The gateway this provider talks to: the URL and key stored by `/login`,
 * falling back to the ambient environment. Undefined until a key is
 * configured, so the provider stays invisible in /model until logged in.
 */
async function resolveGateway(
	credential: Credential | undefined,
	env: (name: string) => string | undefined | Promise<string | undefined>,
): Promise<Gateway | undefined> {
	const stored = credential?.type === "api_key" ? credential : undefined;
	const key = stored?.key ?? (await env(ENV_KEY))?.trim();
	if (!key) return undefined;
	const url =
		normalizeBaseUrl(stored?.env?.[ENV_URL]) ??
		normalizeBaseUrl(await env(ENV_URL)) ??
		DEFAULT_BASE_URL;
	return { url, key };
}

async function listModels(gateway: Gateway, signal: AbortSignal | undefined): Promise<Model<Api>[]> {
	const url = `${gateway.url}/models`;
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${gateway.key}`, Accept: "application/json" },
			signal: AbortSignal.any(signal ? [signal, timeout] : [timeout]),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new Error(`magpie: ${url} timed out after ${DISCOVERY_TIMEOUT_MS / 1000}s`);
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`magpie: cannot reach ${gateway.url} (${reason})`);
	}
	if (!response.ok) {
		throw new Error(`magpie: GET ${url} answered ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { data?: MagpieModel[] };
	const models = new Map<string, Model<Api>>();
	for (const entry of payload?.data ?? []) {
		const model = toModel(entry, gateway.url);
		// First id wins: magpie lists provider/model ids before its optional
		// bare aliases, and both spellings point at the same model.
		if (model && !models.has(model.id)) models.set(model.id, model);
	}
	return [...models.values()];
}

function toModel(entry: MagpieModel, baseUrl: string): Model<Api> | null {
	const id = entry?.id?.trim();
	if (!id) return null;
	// Bare aliases (settings.BareModelIDs) would double the picker; every
	// real entry is "provider/model", "group/<id>" or "auto/<model>".
	if (!id.includes("/")) return null;
	// magpie flags non-chat entries (image, decision) with a kind.
	if (entry.kind && entry.kind !== "model") return null;

	const input = entry.modalities?.input;
	if (input?.length && !input.includes("text")) return null;

	const levels = reasoningLevels(entry);
	const reasoning = entry.reasoning ?? levels.length > 0;
	const contextWindow =
		positive(entry.context_window) ?? positive(entry.context_length) ?? positive(entry.max_input_tokens);

	const model: Model<Api> = {
		id,
		name: entry.display_name?.trim() || id,
		api: "openai-responses",
		provider: PROVIDER_ID,
		baseUrl,
		reasoning,
		input: input?.includes("image") ? ["text", "image"] : ["text"],
		contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positive(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
		cost: {
			input: perMillion(entry.pricing?.prompt),
			output: perMillion(entry.pricing?.completion),
			cacheRead: perMillion(entry.pricing?.input_cache_read),
			cacheWrite: perMillion(entry.pricing?.input_cache_write),
		},
	};
	// magpie names the efforts a model takes; anything it leaves out is
	// unsupported, so Pi clamps to one it does take. A model whose levels
	// magpie does not know keeps Pi's default ladder.
	if (reasoning && levels.length > 0) model.thinkingLevelMap = thinkingLevelMap(levels);
	return model;
}

function thinkingLevelMap(levels: string[]): Record<PiLevel, string | null> {
	const known = new Set(levels);
	// "off" stays "none": magpie clears the reasoning ask for it.
	return Object.fromEntries(
		PI_LEVELS.map((level) => [level, level === "off" ? "none" : known.has(level) ? level : null]),
	) as Record<PiLevel, string | null>;
}

function reasoningLevels(entry: MagpieModel): string[] {
	if (Array.isArray(entry.reasoning_levels)) return entry.reasoning_levels;
	if (Array.isArray(entry.supported_reasoning_levels)) {
		return entry.supported_reasoning_levels
			.map((level) => level?.effort)
			.filter((effort): effort is string => Boolean(effort));
	}
	return [];
}

/**
 * Normalizes what a user types or the environment holds into the OpenAI-style
 * base URL magpie serves: a scheme is added when missing, a bare host gets
 * `/v1`, and trailing slashes go.
 */
function normalizeBaseUrl(input: string | undefined): string | undefined {
	const raw = input?.trim();
	if (!raw) return undefined;
	// A bare host is local when it names a loopback spelling; anything else
	// is assumed to be a public gateway and gets https.
	const scheme = raw.includes("://") ? "" : isLoopback(raw) ? "http://" : "https://";
	let parsed: URL;
	try {
		parsed = new URL(scheme + raw);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	const path = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = path === "" ? "/v1" : path;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

/** Whether a URL points at this machine, i.e. a gateway that takes any key. */
function isLoopback(value: string): boolean {
	try {
		const host = new URL(value.includes("://") ? value : `http://${value}`).hostname;
		return host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host.startsWith("127.");
	} catch {
		return false;
	}
}

/** magpie prices in USD per token, as decimal strings; Pi counts per million. */
function perMillion(perToken: string | undefined): number {
	const value = Number(perToken);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Number((value * 1_000_000).toFixed(6));
}

function positive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
