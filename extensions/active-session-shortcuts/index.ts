import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function activeSessionShortcuts(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description: "Rename current session",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Rename requires Pi to be idle", "warning");
				return;
			}

			const requestedName = args.trim();
			const nextName = requestedName || await ctx.ui.input("Session name (empty to clear)", pi.getSessionName() ?? "");
			if (nextName === undefined) return;

			const normalized = nextName.trim();
			pi.setSessionName(normalized);
			ctx.ui.notify(
				normalized ? `Session renamed: ${normalized}` : "Session name cleared",
				"info",
			);
		},
	});
}
