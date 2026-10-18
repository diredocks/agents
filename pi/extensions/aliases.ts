/**
 * Generic slash-command aliases.
 *
 * Define any number of aliases in ALIASES (alias -> target, without the "/").
 * Each alias is registered as a command and forwards its arguments to the target.
 *
 * Forwarding rules (because Pi has no generic "run this slash command" API):
 * - Built-in commands that ExtensionCommandContext can reproduce are handled
 *   directly through BUILTINS below: new, compact, reload, quit, name.
 * - Extension commands, prompt templates, and skills are forwarded through
 *   sendUserMessage({ expandPromptTemplates: true }).
 * - Built-ins without an exposed programmatic equivalent (model, tree, fork,
 *   resume, export, share, ...) cannot be aliased this way.
 * - Targets can be chained (a -> b -> c); cycles are ignored.
 *
 * Usage:
 *   /clear            -> /new
 *   (enable the commented entries for more, e.g. /c -> /compact)
 *
 * Place in ~/.pi/agent/extensions/ or .pi/extensions/ and run /reload.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** alias -> target command (without the leading "/"). Add your own entries. */
const ALIASES: Record<string, string> = {
	clear: "new",
	exit: "quit",
	// brief: "summarize", // a prompt template or skill also works
};

type BuiltinRunner = (args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) => Promise<void> | void;

/**
 * Built-ins that can be reproduced with the extension command context.
 * Keep this list conservative: an alias must behave exactly like its target.
 */
const BUILTINS: Record<string, BuiltinRunner> = {
	new: async (_args, ctx) => {
		const result = await ctx.newSession({
			// The old ctx is invalid after a successful replacement.
			withSession: async (replacementCtx) => {
				replacementCtx.ui.notify("✓ New session started", "info");
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("New session cancelled", "info");
		}
	},
	compact: async (args, ctx) => {
		await ctx.compact({ customInstructions: args.trim() || undefined });
	},
	reload: async (_args, ctx) => {
		await ctx.reload();
	},
	quit: (_args, ctx) => {
		ctx.shutdown();
	},
	name: (args, ctx, pi) => {
		const name = args.trim();
		if (name) {
			pi.setSessionName(name);
			ctx.ui.notify(`Session named: ${name}`, "info");
		} else {
			const current = pi.getSessionName();
			ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
		}
	},
};

/** Follow alias -> alias -> ... and return the final target, or undefined on a cycle. */
function resolveTarget(alias: string): string | undefined {
	const seen = new Set<string>([alias]);
	let target = ALIASES[alias];
	while (target !== undefined) {
		if (seen.has(target)) return undefined;
		seen.add(target);
		const next = ALIASES[target];
		if (next === undefined) return target;
		target = next;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	for (const [alias, target] of Object.entries(ALIASES)) {
		const resolved = resolveTarget(alias);
		if (resolved === undefined) {
			console.error(`[aliases] Skipping /${alias}: ${alias} -> ${target} forms a cycle.`);
			continue;
		}

		pi.registerCommand(alias, {
			description: `Alias for /${resolved}`,
			handler: async (args, ctx) => {
				const builtin = BUILTINS[resolved];
				if (builtin) {
					await builtin(args, ctx, pi);
					return;
				}

				const isLoadedCommand = pi.getCommands().some((command) => command.name === resolved);
				if (!isLoadedCommand) {
					ctx.ui.notify(
						`/${alias} points to /${resolved}, which is not a built-in alias target or a loaded command.`,
						"error",
					);
					return;
				}

				// Extension commands run immediately; prompt templates and skills
				// expand and start a turn. sendUserMessage covers all three.
				const text = `/${resolved}${args.trim() ? ` ${args.trim()}` : ""}`;
				if (ctx.isIdle()) {
					pi.sendUserMessage(text, { expandPromptTemplates: true });
				} else {
					pi.sendUserMessage(text, { expandPromptTemplates: true, deliverAs: "steer" });
				}
			},
		});
	}
}
