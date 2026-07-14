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

function formatLabelTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	const now = new Date();
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (date.toDateString() === now.toDateString()) return time;
	const datePart = `${date.getMonth() + 1}/${date.getDate()}`;
	return date.getFullYear() === now.getFullYear()
		? `${datePart} ${time}`
		: `${String(date.getFullYear()).slice(-2)}/${datePart} ${time}`;
}

function automaticTimeLabel(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}`;
}

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
	setLabel: (entryId: string, label: string | undefined) => void,
): TelescopeProvider<SessionTreeSearchItem> {
	const info = MODE_INFO[mode];
	let showLabelTimestamps = false;

	const applyLabel = (item: SessionTreeSearchItem, label: string | undefined) => {
		setLabel(item.navigationTargetId, label);
		item.label = label;
		item.labelTimestamp = label ? new Date().toISOString() : undefined;
	};

	const editItemLabel = async (item: SessionTreeSearchItem) => {
		const value = await ctx.ui.editor("Label (empty to remove)", item.label ?? "");
		if (value === undefined) return;
		applyLabel(item, value.trim() || undefined);
	};

	return {
		name: info.name,
		icon: info.icon,
		description: info.description,
		showPreviewByDefault: false,
		enterOpensActions: true,

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
			const timestamp = showLabelTimestamps && item.label && item.labelTimestamp
				? `${theme.fg("dim", formatLabelTimestamp(item.labelTimestamp))} `
				: "";
			return `${active} ${indent}${kindLabel(item, theme)} ${label}${timestamp}${item.title}`;
		},

		async onSelect(item) {
			await navigate(item.navigationTargetId);
		},

		async editLabel(item) {
			await editItemLabel(item);
		},

		actions: [
			{ key: "l", label: "Label", description: "Set or clear the selected entry label" },
			{ key: "t", label: "Label by time", description: "Label with the current local date and time" },
			{ key: "g", label: "Jump", description: "Navigate without summarizing the abandoned branch" },
		],

		async onAction(actionKey, items) {
			const item = items[0];
			if (!item) return;
			if (actionKey === "l") {
				await editItemLabel(item);
			} else if (actionKey === "t") {
				const label = automaticTimeLabel();
				applyLabel(item, label);
				ctx.ui.notify(`Labeled: ${label}`, "info");
			} else if (actionKey === "g") {
				await navigate(item.navigationTargetId);
			}
		},

		toggleLabelTimestamps() {
			showLabelTimestamps = !showLabelTimestamps;
		},

		getKeyHints() {
			return [
				{ key: "S-L", label: "label" },
				{ key: "S-T", label: "label time" },
			];
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
