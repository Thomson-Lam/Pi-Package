import type {
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { TelescopeProvider } from "../types.js";
import {
	collectSessionTreeItems,
	type SessionTreeSearchItem,
	type SessionTreeSearchMode,
} from "../session-tree.js";

const MODE_INFO: Record<SessionTreeSearchMode, { name: string; icon: string; description: string }> = {
	all: {
		name: "tree",
		icon: "🌳",
		description: "Entire current session tree",
	},
	user: {
		name: "tree-user",
		icon: "👤",
		description: "User prompts across the session tree",
	},
	agent: {
		name: "tree-agent",
		icon: "🤖",
		description: "Agent responses across the session tree",
	},
	tools: {
		name: "tree-tools",
		icon: "🔧",
		description: "Tool calls across the session tree",
	},
};

function kindLabel(item: SessionTreeSearchItem, theme: Theme): string {
	switch (item.kind) {
		case "user": return theme.fg("accent", "user");
		case "agent": return theme.fg("success", "agent");
		case "tool": return theme.fg("warning", item.toolName ?? "tool");
		case "summary": return theme.fg("warning", "summary");
		case "compaction": return theme.fg("borderAccent", "compact");
		case "custom": return theme.fg("customMessageLabel", "custom");
	}
}

export function createSessionTreeProvider(
	ctx: ExtensionContext,
	mode: SessionTreeSearchMode,
	navigate: (entryId: string) => Promise<void>,
): TelescopeProvider<SessionTreeSearchItem> {
	const info = MODE_INFO[mode];
	return {
		name: info.name,
		icon: info.icon,
		description: info.description,
		showPreviewByDefault: false,

		load() {
			return collectSessionTreeItems(ctx.sessionManager, mode);
		},

		getSearchText(item) {
			return item.searchText;
		},

		getDisplayText(item, theme) {
			const active = item.active ? theme.fg("accent", "●") : " ";
			const indent = theme.fg("dim", "· ".repeat(Math.min(item.depth, 8)));
			const label = item.label ? `${theme.fg("warning", `[${item.label}]`)} ` : "";
			return `${active} ${indent}${kindLabel(item, theme)} ${label}${item.title}`;
		},

		async onSelect(item) {
			await navigate(item.navigationTargetId);
		},

		getPreview(item, maxLines, theme) {
			const metadata = [
				`${item.kind}${item.toolName ? ` · ${item.toolName}` : ""}`,
				`entry ${item.entryId}${item.navigationTargetId !== item.entryId ? ` · navigate ${item.navigationTargetId}` : ""}`,
				item.label ? `label: ${item.label}` : "",
				item.active ? "active branch" : "alternate branch",
			].filter(Boolean);
			const header = theme
				? metadata.map((line) => theme.fg("dim", line))
				: metadata;
			return [...header, "", ...item.previewText.split("\n")].slice(0, maxLines);
		},

		getFrecencyKey(item) {
			return item.toolCallId ?? `${item.kind}:${item.entryId}`;
		},
	};
}
