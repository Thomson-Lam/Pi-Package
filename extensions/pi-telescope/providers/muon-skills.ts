/**
 * Muon Skill Library Provider
 *
 * Browse every bundled Muon skill and attach one to the editor for one-shot use,
 * regardless of whether Pi currently has that skill loaded.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelescopeProvider } from "../types.js";
import { copyToClipboard } from "../clipboard.js";

interface MuonSkillInfo {
	name: string;
	description: string;
	path: string;
	baseDir: string;
	skillset: string;
	body: string;
}

const MUON_SKILLSETS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"muon",
	"skillsets",
);

function parseFrontmatter(content: string): { body: string; fields: Map<string, string> } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return { body: content.trim(), fields: new Map() };

	const lines = match[1]!.split(/\r?\n/);
	const fields = new Map<string, string>();
	for (let i = 0; i < lines.length; i++) {
		const field = lines[i]!.match(/^([\w-]+):\s*(.*)$/);
		if (!field) continue;
		const [, key, rawValue] = field;
		if (rawValue === ">" || rawValue === "|") {
			const continuation: string[] = [];
			while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
				continuation.push(lines[++i]!.trim());
			}
			fields.set(key!, rawValue === ">" ? continuation.join(" ") : continuation.join("\n"));
		} else {
			fields.set(key!, rawValue!.replace(/^["']|["']$/g, "").trim());
		}
	}

	return { body: content.slice(match[0].length).trim(), fields };
}

function discoverMuonSkills(dir: string): MuonSkillInfo[] {
	const skills: MuonSkillInfo[] = [];

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const entryDir = join(dir, entry.name);
		const children = readdirSync(entryDir, { withFileTypes: true });
		const skillFile = children.find((child) => child.isFile() && child.name === "SKILL.md");

		if (skillFile) {
			const path = join(entryDir, skillFile.name);
			const { body, fields } = parseFrontmatter(readFileSync(path, "utf-8"));
			skills.push({
				name: fields.get("name") || entry.name,
				description: fields.get("description") || "(no description)",
				path,
				baseDir: entryDir,
				skillset: relative(MUON_SKILLSETS_DIR, entryDir).split(/[\\/]/)[0] || "muon",
				body,
			});
			continue;
		}

		skills.push(...discoverMuonSkills(entryDir));
	}

	return skills;
}

function formatOneShotSkill(skill: MuonSkillInfo): string {
	return `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
}

export function createMuonSkillsProvider(): TelescopeProvider<MuonSkillInfo> {
	return {
		name: "muon-skills",
		icon: "μ",
		description: "All Muon skills (attach for one-shot use)",

		load() {
			return discoverMuonSkills(MUON_SKILLSETS_DIR);
		},

		getSearchText(item) {
			return `${item.name} ${item.skillset} ${item.description}`;
		},

		getDisplayText(item, theme) {
			return `[${theme.fg("accent", item.skillset)}] ${theme.bold(item.name)} ${theme.fg("dim", item.description)}`;
		},

		onSelect(item, ctx) {
			ctx.ui.pasteToEditor(`${formatOneShotSkill(item)}\n\n`);
		},

		getPreview(item, maxLines) {
			return readFileSync(item.path, "utf-8").split("\n").slice(0, maxLines);
		},

		getFrecencyKey(item) {
			return item.name;
		},

		actions: [
			{ key: "c", label: "Copy path", description: "Copy SKILL.md path to clipboard" },
		],

		onAction(actionKey, items) {
			if (actionKey === "c") {
				copyToClipboard(items.map((item) => item.path).join("\n"));
			}
		},
	};
}
