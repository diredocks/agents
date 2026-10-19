/**
 * Desktop notify extension.
 *
 * Sends a native desktop notification when a full Pi run settles
 * (agent_settled, i.e. no automatic retry, compaction, or queued work will
 * continue), so you know the agent is done and waiting for your input.
 *
 * The notification backend is chosen automatically per platform; the first
 * one that works wins:
 *   - macOS:   osascript (Notification Center)
 *   - Windows: PowerShell toast (also WSL, detected via WT_SESSION)
 *   - Linux:   notify-send -> freedesktop D-Bus (dbus-send) -> busctl
 *   - Fallback: terminal OSC 777 / 99 escape sequences
 *
 * Commands:
 *   /notify            show current status and backend
 *   /notify on|off     enable / disable desktop notifications (persisted)
 *   /notify test       send a test notification immediately
 *
 * Environment:
 *   PI_DESKTOP_NOTIFY=0   start disabled (takes precedence over the config file)
 *
 * Install by placing this file in ~/.pi/agent/extensions/ and running /reload.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const APP_NAME = "Pi";
const EXEC_TIMEOUT_MS = 4000;
const NOTIFY_TIMEOUT_MS = 5000;
/** Do not retry a completely unavailable backend set on every run. */
const BACKEND_RETRY_MS = 60_000;
const CONFIG_PATH = join(getAgentDir(), "desktop-notify.json");

/** Run a command without blocking; resolve on success, reject on failure. */
function run(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

interface Backend {
	name: string;
	send(title: string, body: string): Promise<void>;
}

function macBackend(): Backend {
	return {
		name: "osascript",
		// AppleScript string: wrap in double quotes and escape backslashes/quotes.
		send: (title, body) => {
			const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			return run("osascript", [
				"-e",
				`display notification ${quote(body)} with title ${quote(title)} sound name "Ping"`,
			]);
		},
	};
}

function windowsBackend(): Backend {
	return {
		name: "powershell-toast",
		send: (title, body) => {
			const single = (text: string) => text.replace(/'/g, "''");
			const type = "Windows.UI.Notifications";
			const script = [
				`[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime] > $null`,
				`$xml = [${type}.ToastNotificationManager]::GetTemplateContent([${type}.ToastTemplateType]::ToastText01)`,
				`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${single(body)}')) > $null`,
				`[${type}.ToastNotificationManager]::CreateToastNotifier('${single(title)}').Show([${type}.ToastNotification]::new($xml))`,
			].join("; ");
			return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
		},
	};
}

/** notify-send (libnotify); rejects when missing, then D-Bus is tried. */
function notifySendBackend(): Backend {
	return {
		name: "notify-send",
		send: (title, body) =>
			run("notify-send", [
				"--app-name",
				APP_NAME,
				"--urgency",
				"normal",
				"--expire-time",
				String(NOTIFY_TIMEOUT_MS),
				title,
				body,
			]),
	};
}

/** Call org.freedesktop.Notifications.Notify directly (works on KDE / GNOME). */
function dbusSendBackend(): Backend {
	return {
		name: "dbus-send",
		send: (title, body) =>
			run("dbus-send", [
				"--session",
				"--type=method_call",
				"--dest=org.freedesktop.Notifications",
				"/org/freedesktop/Notifications",
				"org.freedesktop.Notifications.Notify",
				`string:${APP_NAME}`,
				"uint32:0",
				"string:",
				`string:${title}`,
				`string:${body}`,
				"array:string:",
				"dict:string:variant:",
				`int32:${NOTIFY_TIMEOUT_MS}`,
			]),
	};
}

/** busctl fallback (systemd) for Linux desktops without notify-send/dbus-send. */
function busctlBackend(): Backend {
	return {
		name: "busctl",
		send: (title, body) =>
			run("busctl", [
				"--user",
				"call",
				"org.freedesktop.Notifications",
				"/org/freedesktop/Notifications",
				"org.freedesktop.Notifications",
				"Notify",
				"susssasa{sv}i",
				APP_NAME,
				"0",
				"",
				title,
				body,
				"0",
				"0",
				String(NOTIFY_TIMEOUT_MS),
			]),
	};
}

/** Terminal OSC escape sequence, used only when a TUI owns stdout. */
function terminalNotify(title: string, body: string): void {
	const clean = (text: string) => text.replace(/[\x00-\x1f\x7f;]/g, " ");
	try {
		if (process.env.KITTY_WINDOW_ID) {
			// Kitty OSC 99
			process.stdout.write(`\x1b]99;i=1:d=0;${clean(title)}\x1b\\`);
			process.stdout.write(`\x1b]99;i=1:p=body;${clean(body)}\x1b\\`);
		} else {
			// OSC 777: Ghostty / iTerm2 / WezTerm / rxvt-unicode
			process.stdout.write(`\x1b]777;notify;${clean(title)};${clean(body)}\x07`);
		}
	} catch {
		// Ignore: fail silently when the terminal is not writable.
	}
}

/** Return the candidate backends for the current platform. */
function candidateBackends(): Backend[] {
	// On WSL prefer the Windows toast even though process.platform is linux.
	if (process.env.WT_SESSION) return [windowsBackend()];

	switch (process.platform) {
		case "darwin":
			return [macBackend()];
		case "win32":
			return [windowsBackend()];
		case "linux":
			return [notifySendBackend(), dbusSendBackend(), busctlBackend()];
		default:
			return [];
	}
}

interface Config {
	enabled: boolean;
}

function loadConfig(): Config {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
		return { enabled: raw.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

function saveConfig(config: Config): void {
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Ignore: fall back to an in-memory toggle in read-only environments.
	}
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export default function (pi: ExtensionAPI) {
	// The environment variable takes precedence over the config file.
	const envOverride = process.env.PI_DESKTOP_NOTIFY;
	let enabled = envOverride === undefined ? loadConfig().enabled : envOverride !== "0";

	// Cache the first backend that succeeds instead of retrying from the top.
	let activeBackend: Backend | undefined;
	let unavailableUntil = 0;
	let runStartedAt: number | undefined;

	/** Send a notification; returns whether a GUI backend delivered it. */
	async function deliver(title: string, body: string, allowTerminal: boolean): Promise<boolean> {
		if (Date.now() < unavailableUntil) {
			if (allowTerminal) terminalNotify(title, body);
			return false;
		}

		const cached = activeBackend;
		const backends = cached
			? [cached, ...candidateBackends().filter((backend) => backend.name !== cached.name)]
			: candidateBackends();

		for (const backend of backends) {
			try {
				await backend.send(title, body);
				activeBackend = backend;
				unavailableUntil = 0;
				return true;
			} catch {
				if (activeBackend === backend) activeBackend = undefined;
			}
		}

		// Do not retry a completely unavailable set on every run.
		unavailableUntil = Date.now() + BACKEND_RETRY_MS;
		if (allowTerminal) terminalNotify(title, body);
		return false;
	}

	function currentBackendName(): string {
		if (activeBackend) return activeBackend.name;
		const names = candidateBackends().map((backend) => backend.name);
		return names.length ? `${names.join(" -> ")} (auto)` : "terminal OSC";
	}

	pi.on("agent_start", async () => {
		runStartedAt = Date.now();
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!enabled) return;

		const project = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ctx.cwd;
		const session = pi.getSessionName();
		const summary = session ?? project;

		const parts: string[] = [];
		if (session && project && session !== project) parts.push(`[${project}] ${session}`);
		else parts.push(summary);
		if (runStartedAt !== undefined) {
			parts.push(`in ${formatDuration(Date.now() - runStartedAt)}`);
		}
		runStartedAt = undefined;

		const title = event.aborted ? `${APP_NAME} · Interrupted` : `${APP_NAME} · Task complete`;
		const body = parts.join(" · ");

		// Do not hold up settlement while a notifier is missing or slow.
		void deliver(title, body, ctx.mode === "tui");
	});

	pi.registerCommand("notify", {
		description: "Desktop notifications: /notify [on|off|test]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg) {
				ctx.ui.notify(
					`Desktop notifications: ${enabled ? "on" : "off"} · backend: ${currentBackendName()}`,
					"info",
				);
				return;
			}

			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				saveConfig({ enabled });
				ctx.ui.notify(`Desktop notifications ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (arg === "test") {
				const ok = await deliver(
					`${APP_NAME} · Test notification`,
					"Desktop notifications are working ✅",
					ctx.mode === "tui",
				);
				const failure = ctx.mode === "tui"
					? "No desktop notification backend found; fell back to terminal notification"
					: "No desktop notification backend found";
				ctx.ui.notify(ok ? `Sent (backend: ${currentBackendName()})` : failure, ok ? "info" : "warning");
				return;
			}

			ctx.ui.notify("Usage: /notify [on|off|test]", "warning");
		},
	});
}
