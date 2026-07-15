import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STARTUP_COMMAND_DELAY_MS = 75;

export default function startupCommandExtension(pi: ExtensionAPI): void {
	pi.registerFlag("startup-command", {
		description: "Run a slash command after Pi starts in TUI mode",
		type: "string",
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		if (ctx.mode !== "tui") return;

		const command = pi.getFlag("startup-command");
		if (typeof command !== "string") return;

		const text = command.trim();
		if (!text) return;

		setTimeout(() => {
			try {
				ctx.ui.setEditorText(text);
				process.stdin.emit("data", "\r");
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Startup command failed: ${msg}`, "error");
			}
		}, STARTUP_COMMAND_DELAY_MS);
	});
}
