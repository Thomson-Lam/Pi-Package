import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function activeSessionShortcuts(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+shift+r", {
		description: "Rename current session",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Rename requires Pi to be idle", "warning");
				return;
			}

			const currentName = pi.getSessionName() ?? "";
			const nextName = await ctx.ui.input("Session name (empty to clear)", currentName);
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
