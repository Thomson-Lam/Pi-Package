/**
 * Pi Skills Provider
 *
 * Browse skills currently available in Pi with SKILL.md preview.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TelescopeProvider } from "../types.js";
import { copyToClipboard } from "../clipboard.js";

interface SkillInfo {
	name: string;
	command: string;
	description: string;
	path: string;
	scope: "project" | "user" | "temporary";
}

function resolveSkillPath(path: string): string {
	if (path.endsWith("SKILL.md")) return path;
	const skillFile = join(path, "SKILL.md");
	return existsSync(skillFile) ? skillFile : path;
}

function loadAvailableSkills(pi: ExtensionAPI): SkillInfo[] {
	return pi.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name.startsWith("skill:")
				? command.name.slice("skill:".length)
				: command.name,
			command: command.name,
			description: command.description ?? "(no description)",
			path: resolveSkillPath(command.sourceInfo.path),
			scope: command.sourceInfo.scope,
		}));
}

export function createSkillsProvider(pi: ExtensionAPI): TelescopeProvider<SkillInfo> {
	return {
		name: "skills",
		icon: "📚",
		description: "Available Pi skills",

		load() {
			return loadAvailableSkills(pi);
		},

		getSearchText(item) {
			return `${item.name} ${item.description}`;
		},

		getDisplayText(item, theme) {
			const scopeBadge =
				item.scope === "project" ? theme.fg("success", "P")
				: item.scope === "user" ? theme.fg("warning", "U")
				: theme.fg("dim", "T");
			return `[${scopeBadge}] ${theme.bold(item.name)} ${theme.fg("dim", item.description)}`;
		},

		async onSelect(item, ctx) {
			ctx.ui.pasteToEditor(`/${item.command} `);
		},

		getPreview(item, maxLines) {
			try {
				const content = readFileSync(item.path, "utf-8");
				return content.split("\n").slice(0, maxLines);
			} catch {
				return ["(no preview)"];
			}
		},

		getFrecencyKey(item) {
			return item.name;
		},

		actions: [
			{ key: "c", label: "Copy path", description: "Copy SKILL.md path to clipboard" },
		],

		onAction(actionKey, items) {
			if (actionKey === "c") {
				copyToClipboard(items.map((i) => i.path).join("\n"));
			}
		},
	};
}
