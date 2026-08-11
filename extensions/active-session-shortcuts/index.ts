import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function localTimestamp(): string {
	return new Intl.DateTimeFormat("sv-SE", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(new Date());
}

export default function activeSessionShortcuts(pi: ExtensionAPI): void {
	pi.registerCommand("rn", {
		description: "Rename current session with a local timestamp",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Rename requires Pi to be idle", "warning");
				return;
			}

			const requestedSubject = args.trim() || await ctx.ui.input("Session subject", "");
			if (requestedSubject === undefined) return;
			const subject = requestedSubject.trim().replace(/\s+/g, " ");
			if (!subject) return;

			const name = `${localTimestamp()} — ${subject}`;
			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed: ${name}`, "info");
		},
	});

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
