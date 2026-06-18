import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, "skills");
const GLOBAL_HANDOFFS_DIR = join(homedir(), ".pi", "agent", "handoffs");

type AttachScope = "global" | "local";
type HattachAction = "help" | "attach-local" | "attach-global";

type HandoffCandidate = {
	scope: AttachScope;
	path: string;
	label: string;
	mtimeMs: number;
};

const HELP_TEXT = `# /hattach

Attach an existing handoff to the next user turn without starting the agent immediately.

## Commands

- /hattach — open the handoff attach menu
- /hattach help — show this help
- /hattach attach local — attach a local repo handoff
- /hattach attach global — attach a global repo handoff

## Locations

Local handoffs:
docs/handoff/handoff-*.md

Global handoffs across all repos:
~/.pi/agent/handoffs/<repo-slug>/handoff-*.md

When multiple handoffs exist, /hattach opens a picker. The selected handoff is attached directly to the current session context.`;

type ParsedHattach = { kind: "menu" } | { kind: "action"; action: HattachAction } | { kind: "error"; message: string };

function parseAction(args: string): ParsedHattach {
	const normalized = args.trim().toLowerCase().replace(/\s+/g, " ");
	if (!normalized) return { kind: "menu" };
	if (normalized === "help") return { kind: "action", action: "help" };
	if (normalized === "attach local" || normalized === "local") return { kind: "action", action: "attach-local" };
	if (normalized === "attach global" || normalized === "global") return { kind: "action", action: "attach-global" };
	return { kind: "error", message: "Usage: /hattach [help|attach local|attach global]" };
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5000 });
		const value = stdout.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

function slugifyRepoSource(source: string): string {
	const slug = source
		.trim()
		.toLowerCase()
		.replace(/^(git@|https?:\/\/)/, "")
		.replace(/:/g, "/")
		.replace(/\.git$/, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
	return slug || "repo";
}

async function getRepoInfo(cwd: string): Promise<{ root: string; slug: string }> {
	const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])) || cwd;
	const remote = await runGit(root, ["config", "--get", "remote.origin.url"]);
	return { root, slug: slugifyRepoSource(remote || root) };
}

async function resolveHandoffDir(ctx: ExtensionCommandContext, scope: AttachScope): Promise<string> {
	const repo = await getRepoInfo(ctx.cwd);
	if (scope === "local") return join(repo.root, "docs", "handoff");
	return join(GLOBAL_HANDOFFS_DIR, repo.slug);
}

function subjectFromFileName(fileName: string): string {
	return fileName.replace(/^handoff-/, "").replace(/\.md$/, "");
}

async function listLocalHandoffs(ctx: ExtensionCommandContext): Promise<HandoffCandidate[]> {
	const dir = await resolveHandoffDir(ctx, "local");
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const candidates: HandoffCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/^handoff-.+\.md$/.test(entry.name)) continue;
		const path = join(dir, entry.name);
		const info = await stat(path);
		const subject = subjectFromFileName(entry.name);
		candidates.push({ scope: "local", path, label: `${subject} — ${path}`, mtimeMs: info.mtimeMs });
	}
	return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listGlobalHandoffs(): Promise<HandoffCandidate[]> {
	if (!existsSync(GLOBAL_HANDOFFS_DIR)) return [];
	const repoEntries = await readdir(GLOBAL_HANDOFFS_DIR, { withFileTypes: true });
	const candidates: HandoffCandidate[] = [];
	for (const repoEntry of repoEntries) {
		if (!repoEntry.isDirectory()) continue;
		const repoDir = join(GLOBAL_HANDOFFS_DIR, repoEntry.name);
		const handoffEntries = await readdir(repoDir, { withFileTypes: true });
		for (const handoffEntry of handoffEntries) {
			if (!handoffEntry.isFile() || !/^handoff-.+\.md$/.test(handoffEntry.name)) continue;
			const path = join(repoDir, handoffEntry.name);
			const info = await stat(path);
			const subject = subjectFromFileName(handoffEntry.name);
			candidates.push({
				scope: "global",
				path,
				label: `${repoEntry.name} / ${subject} — ${path}`,
				mtimeMs: info.mtimeMs,
			});
		}
	}
	return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listHandoffsForScope(ctx: ExtensionCommandContext, scope: AttachScope): Promise<HandoffCandidate[]> {
	return scope === "local" ? listLocalHandoffs(ctx) : listGlobalHandoffs();
}

async function selectModal(ctx: ExtensionCommandContext, title: string, items: SelectItem[]): Promise<string | undefined> {
	const result = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "j" || data === "J") selectList.handleInput("\x1b[B");
				else if (data === "k" || data === "K") selectList.handleInput("\x1b[A");
				else selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result;
}

async function pickHandoff(ctx: ExtensionCommandContext, scope: AttachScope): Promise<HandoffCandidate | undefined> {
	const candidates = await listHandoffsForScope(ctx, scope);
	if (candidates.length === 0) {
		const dir = scope === "global" ? GLOBAL_HANDOFFS_DIR : await resolveHandoffDir(ctx, scope);
		ctx.ui.notify(`No ${scope} handoffs found in ${dir}`, "error");
		return undefined;
	}
	if (candidates.length === 1) return candidates[0];

	const items = candidates.map((candidate) => {
		const subject = subjectFromFileName(basename(candidate.path));
		const repoPrefix = candidate.scope === "global" ? `${relative(GLOBAL_HANDOFFS_DIR, dirname(candidate.path))} / ` : "";
		return {
			value: candidate.path,
			label: `${repoPrefix}${subject}`,
			description: candidate.path,
		};
	});
	const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
	const selected = await selectModal(ctx, `Attach ${scope} handoff`, items);
	return selected ? byPath.get(selected) : undefined;
}

async function pickAction(ctx: ExtensionCommandContext): Promise<HattachAction | undefined> {
	const selected = await selectModal(ctx, "Handoff attach", [
		{ value: "help", label: "Help", description: "Show hattach help" },
		{ value: "attach-local", label: "Attach local", description: "Pick from docs/handoff/handoff-*.md" },
		{ value: "attach-global", label: "Attach global", description: "Pick from ~/.pi/agent/handoffs/<repo-slug>/handoff-*.md" },
	]);
	return selected as HattachAction | undefined;
}

async function showHelp(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Handoff Attach Help")), 1, 0));
			container.addChild(new Text(HELP_TEXT, 1, 1));
			container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to dismiss"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (data === "\r" || data === "\n" || data === "\x1b") done();
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", margin: 2 } },
	);
}

function buildAttachmentMessage(scope: AttachScope, path: string, body: string): string {
	return `Attached ${scope} handoff from ${path}. Treat this as context for future work in this repository.\n\n${body}`;
}

async function attachHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: AttachScope): Promise<void> {
	const selected = await pickHandoff(ctx, scope);
	if (!selected) return;

	const body = await readFile(selected.path, "utf8");
	const attachment = buildAttachmentMessage(selected.scope, selected.path, body);
	pi.sendMessage(
		{
			customType: "handoff-attachment",
			display: true,
			content: attachment,
			details: {
				kind: "handoff-snapshot",
				scope: selected.scope,
				path: selected.path,
				attachedAt: Date.now(),
			},
		},
		{ triggerTurn: false },
	);
	ctx.ui.notify(`Attached ${selected.scope} handoff to session context: ${selected.path}`, "info");
}

async function runAction(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: HattachAction): Promise<void> {
	if (action === "help") {
		await showHelp(ctx);
		return;
	}
	await attachHandoff(pi, ctx, action === "attach-local" ? "local" : "global");
}

export default function handoffExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: [SKILLS_DIR],
	}));

	pi.registerCommand("hattach", {
		description: "Attach a handoff through a UI picker",
		getArgumentCompletions: (prefix) => {
			const items = ["help", "attach local", "attach global"];
			return items.filter((item) => item.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const parsed = parseAction(args || "");
			if (parsed.kind === "error") {
				ctx.ui.notify(parsed.message, "error");
				return;
			}

			const action = parsed.kind === "menu" ? await pickAction(ctx) : parsed.action;
			if (!action) return;

			try {
				await runAction(pi, ctx, action);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
