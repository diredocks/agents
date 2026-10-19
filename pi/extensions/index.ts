/**
 * Entry point for the personal extension bundle.
 *
 * Pi loads direct files and subdirectories that contain an `index.ts`, so
 * grouping the individual extensions under `shell/`, `feature/`, and
 * `renderer/` needs this aggregator: it imports every factory and calls them
 * in the order the flat files used to be loaded.
 *
 * Load order matters for the editor/renderer wrappers: `better-footer`
 * installs a custom editor first, then `input-history` and `pinned-prompt`
 * wrap whatever editor is currently installed.
 *
 * Usage:
 *   pi -e ./extensions/index.ts
 * or register this workspace as a local package (single source of truth,
 * no copy under ~/.pi/agent/extensions):
 *   pi install ~/Code/project/agents/pi
 * then run `/reload`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Imports stay in the original flat-file order (alphabetical) so module
// evaluation order is unchanged; factories are called in the same order below.
import aliases from "./shell/aliases.ts";
import betterFooter from "./shell/better-footer.ts";
import branchHere from "./feature/branch-here.ts";
import desktopNotify from "./feature/desktop-notify.ts";
import elapsedTime from "./feature/elapsed-time.ts";
import inputHistory from "./shell/input-history.ts";
import jump from "./feature/jump.ts";
import minimalMode from "./renderer/minimal-mode.ts";
import pinnedPrompt from "./shell/pinned-prompt.ts";
import thinkingSpinner from "./renderer/thinking-spinner.ts";
import todoCompact from "./shell/todo-compact.ts";
import turnCollapse from "./renderer/turn-collapse.ts";
import workingElapsed from "./shell/working-elapsed.ts";

export default function (pi: ExtensionAPI): void {
	aliases(pi);
	betterFooter(pi);
	branchHere(pi);
	desktopNotify(pi);
	elapsedTime(pi);
	inputHistory(pi);
	jump(pi);
	minimalMode(pi);
	pinnedPrompt(pi);
	thinkingSpinner(pi);
	todoCompact(pi);
	turnCollapse(pi);
	workingElapsed(pi);
}
