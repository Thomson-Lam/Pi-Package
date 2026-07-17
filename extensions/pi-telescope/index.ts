/**
 * Pi-Telescope Extension
 *
 * A native TUI fuzzy finder for pi, inspired by telescope.nvim and Television.
 *
 * Features:
 *   - Fuzzy search with pattern modifiers ('exact, ^prefix, suffix$, !negate)
 *   - Multi-select with Tab
 *   - Provider switching with Ctrl+R
 *   - Toggle preview with Ctrl+O
 *   - Help panel with Ctrl+G
 *   - Provider-specific actions with Ctrl+E
 *   - Copy to clipboard with Ctrl+Y
 *   - Frecency-aware sorting
 *   - Footer with keybinding hints
 *
 * Keybindings:
 *   Ctrl+Alt+F          → files
 *   Ctrl+Alt+S/K/C      → sessions / skills / commands
 *   Ctrl+Alt+D          → Muon skills
 *   Ctrl+Alt+B/L        → git branches / git log
 *   Ctrl+Alt+T/U/A/X    → full tree / user / agent / tool entries
 *   Ctrl+Alt+Z          → Pi and Telescope help / hotkeys
 *
 * Commands:
 *   /telescope [name]  → open specific provider
 *   /ts [name]         → alias
 *
 * Built-in providers:
 *   files, git-branches, git-log, sessions, skills, muon-skills, commands,
 *   tree, tree-user, tree-agent, tree-tools, help
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, KeyId } from "@mariozechner/pi-tui";
import type { TelescopeProvider } from "./types.js";
import { openTelescope } from "./telescope.js";
import { filterAndScore } from "./scoring.js";
import { getFrecencyMap } from "./frecency.js";

import { createFilesProvider, listFiles } from "./providers/files.js";

import { createGitBranchesProvider } from "./providers/git-branches.js";
import { createGitLogProvider } from "./providers/git-log.js";
import { createSessionsProvider } from "./providers/sessions.js";
import { createSkillsProvider } from "./providers/skills.js";
import { createMuonSkillsProvider } from "./providers/muon-skills.js";
import { createCommandsProvider } from "./providers/commands.js";
import { createSessionTreeProvider } from "./providers/session-tree.js";
import { createHotkeysProvider } from "./providers/hotkeys.js";
import { editResponseInNvim } from "./response-editor.js";

type ProviderFactory = (
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
) => TelescopeProvider;

/** Registry of available providers */
const PROVIDERS: Record<string, ProviderFactory> = {
	"files":        (ctx) => createFilesProvider(ctx.cwd),
	"git-branches": (ctx) => createGitBranchesProvider(ctx.cwd),
	"git-log":      (ctx) => createGitLogProvider(ctx.cwd),
	"sessions":     (ctx) => createSessionsProvider({
		resume: async (path) => {
			await ctx.switchSession(path);
		},
		getActiveSessionPath: () => ctx.sessionManager.getSessionFile(),
	}),
	"skills":       (_ctx, pi) => createSkillsProvider(pi),
	"muon-skills":  () => createMuonSkillsProvider(),
	"commands":     (_ctx, pi) => createCommandsProvider(pi),
	"tree":         (ctx, pi) => createSessionTreeProvider(ctx, "all", async (id) => {
		await ctx.navigateTree(id, { summarize: false });
	}, (id, label) => pi.setLabel(id, label)),
	"tree-user":    (ctx, pi) => createSessionTreeProvider(ctx, "user", async (id) => {
		await ctx.navigateTree(id, { summarize: false });
	}, (id, label) => pi.setLabel(id, label)),
	"tree-agent":   (ctx, pi) => createSessionTreeProvider(ctx, "agent", async (id) => {
		await ctx.navigateTree(id, { summarize: false });
	}, (id, label) => pi.setLabel(id, label)),
	"tree-tools":   (ctx, pi) => createSessionTreeProvider(ctx, "tools", async (id) => {
		await ctx.navigateTree(id, { summarize: false });
	}, (id, label) => pi.setLabel(id, label)),
	"help":         () => createHotkeysProvider(PROVIDER_SHORTCUTS),
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

const PROVIDER_SHORTCUTS: Record<string, KeyId[]> = {
	"files": ["ctrl+alt+f"],
	"sessions": ["ctrl+alt+s"],
	"skills": ["ctrl+alt+k"],
	"muon-skills": ["ctrl+alt+d"],
	"commands": ["ctrl+alt+c"],
	"git-branches": ["ctrl+alt+b"],
	"git-log": ["ctrl+alt+l"],
	"tree": ["ctrl+alt+t"],
	"tree-user": ["ctrl+alt+u"],
	"tree-agent": ["ctrl+alt+a"],
	"tree-tools": ["ctrl+alt+x"],
	"help": ["ctrl+alt+z"],
};

/** Build the allProviders map for Ctrl+R switching */
function buildAllProviders(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Record<string, () => TelescopeProvider> {
	const result: Record<string, () => TelescopeProvider> = {};
	for (const [name, factory] of Object.entries(PROVIDERS)) {
		result[name] = () => factory(ctx, pi);
	}
	return result;
}

function submitEditorCommand(ctx: ExtensionContext, command: string): void {
	ctx.ui.setEditorText(command);
	setTimeout(() => process.stdin.emit("data", "\r"), 0);
}

function createShortcutProvider(
	name: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): TelescopeProvider | undefined {
	const treeModes = {
		"tree": "all",
		"tree-user": "user",
		"tree-agent": "agent",
		"tree-tools": "tools",
	} as const;
	if (name === "sessions") {
		return createSessionsProvider({
			resume: async (path) => {
				submitEditorCommand(ctx, `/telescope-session-switch ${encodeURIComponent(path)}`);
			},
			getActiveSessionPath: () => ctx.sessionManager.getSessionFile(),
		});
	}

	const mode = treeModes[name as keyof typeof treeModes];
	if (mode) {
		return createSessionTreeProvider(
			ctx,
			mode,
			async (id) => {
				submitEditorCommand(ctx, `/telescope-tree-navigate ${id}`);
			},
			(id, label) => pi.setLabel(id, label),
		);
	}

	const factory = PROVIDERS[name];
	if (!factory) return undefined;
	// Non-tree providers only use the base ExtensionContext fields.
	return factory(ctx as ExtensionCommandContext, pi);
}

function buildShortcutProviders(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Record<string, () => TelescopeProvider> {
	const result: Record<string, () => TelescopeProvider> = {};
	for (const name of PROVIDER_NAMES) {
		result[name] = () => createShortcutProvider(name, ctx, pi)!;
	}
	return result;
}

async function runTelescopeShortcut(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	providerName: string,
): Promise<void> {
	const provider = createShortcutProvider(providerName, ctx, pi);
	if (!provider) return;
	await openTelescope(provider, ctx, {
		allProviders: buildShortcutProviders(ctx, pi),
	});
}

async function runTelescope(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerName?: string,
) {
	const name = providerName?.trim().toLowerCase() || "files";
	const factory = PROVIDERS[name];

	if (!factory) {
		ctx.ui.notify(
			`Unknown provider: ${name}. Available: ${PROVIDER_NAMES.join(", ")}`,
			"warning",
		);
		return;
	}

	const provider = factory(ctx, pi);
	await openTelescope(provider, ctx, {
		allProviders: buildAllProviders(ctx, pi),
	});
}

function lastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.trim()) return text;
	}
}

// ---------------------------------------------------------------------------
// @ mention autocomplete replacement
// ---------------------------------------------------------------------------

const MENTION_MAX_RESULTS = 20;

/** Cache of file listings per cwd */
let cachedFiles: string[] = [];
let cachedCwd: string | null = null;

function ensureFileCache(cwd: string): string[] {
	if (cachedCwd !== cwd) {
		cachedFiles = listFiles(cwd);
		cachedCwd = cwd;
	}
	return cachedFiles;
}

/** Invalidate file cache (called on cwd change) */
function invalidateFileCache(): void {
	cachedFiles = [];
	cachedCwd = null;
}

/** Extract the @-prefix from text before cursor, or null if not in an @ context */
function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

/** Parse the raw query and whether it's a quoted @"..." prefix */
function parseAtPrefix(prefix: string): { raw: string; quoted: boolean } {
	if (prefix.startsWith('@"')) {
		return { raw: prefix.slice(2), quoted: true };
	}
	return { raw: prefix.slice(1), quoted: false };
}

/** Build the completion value with proper quoting for paths with spaces */
function buildAtValue(path: string, quotedPrefix: boolean): string {
	if (quotedPrefix || path.includes(" ")) {
		return `@"${path}"`;
	}
	return `@${path}`;
}

/**
 * Autocomplete provider that intercepts @ mentions and uses telescope's
 * fuzzy scoring engine to find files, delegating everything else to the
 * built-in provider.
 */
class TelescopeAtMentionProvider implements AutocompleteProvider {
	constructor(
		private base: AutocompleteProvider,
		private cwd: string,
	) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const atPrefix = extractAtPrefix(textBeforeCursor);

		if (!atPrefix) {
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const { raw, quoted } = parseAtPrefix(atPrefix);

		try {
			const files = ensureFileCache(this.cwd);
			const frecency = getFrecencyMap("files");
			const scored = filterAndScore(
				files,
				raw,
				(f) => f,
				MENTION_MAX_RESULTS,
				frecency,
			);

			if (scored.length === 0) {
				return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items: AutocompleteItem[] = scored.map((s) => {
				const path = s.item;
				const fileName = path.includes("/")
					? path.slice(path.lastIndexOf("/") + 1)
					: path;
				return {
					value: buildAtValue(path, quoted),
					label: fileName,
					description: path,
				};
			});

			return { items, prefix: atPrefix };
		} catch {
			// Fall back to built-in on any error
			return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
		}
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	) {
		return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

/**
 * Custom editor that wraps the autocomplete provider to inject
 * telescope-powered @ mention completions.
 */
class TelescopeEditor extends CustomEditor {
	constructor(
		tui: any,
		theme: any,
		keybindings: any,
		private cwd: string,
	) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(
			new TelescopeAtMentionProvider(provider, this.cwd),
		);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Register custom editor with telescope @ mentions
	pi.on("session_start", async (_event, ctx) => {
		try {
			const cwd = ctx.cwd;
			invalidateFileCache();
			ensureFileCache(cwd);
			ctx.ui.setEditorComponent((tui, theme, keybindings) =>
				new TelescopeEditor(tui, theme, keybindings, cwd),
			);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			ctx.ui.notify(`Telescope @ init failed: ${msg}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
		invalidateFileCache();
	});

	for (const [provider, shortcuts] of Object.entries(PROVIDER_SHORTCUTS)) {
		for (const shortcut of shortcuts) {
			pi.registerShortcut(shortcut, {
				description: `Open Telescope (${provider})`,
				handler: async (ctx) => {
					if (!ctx.isIdle()) {
						ctx.ui.notify("Telescope requires Pi to be idle", "warning");
						return;
					}
					await runTelescopeShortcut(pi, ctx, provider);
				},
			});
		}
	}

	pi.registerCommand("telescope", {
		description: "Open Telescope fuzzy finder (optional: provider name)",
		getArgumentCompletions: (prefix) => {
			const items = PROVIDER_NAMES
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => runTelescope(pi, ctx, args?.trim() || undefined),
	});

	pi.registerCommand("ts", {
		description: "Telescope (alias)",
		getArgumentCompletions: (prefix) => {
			const items = PROVIDER_NAMES
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => runTelescope(pi, ctx, args?.trim() || undefined),
	});

	pi.registerCommand("telescope-hotkeys", {
		description: "Search Pi and Telescope keyboard shortcuts",
		handler: (_args, ctx) => runTelescope(pi, ctx, "help"),
	});

	pi.registerCommand("ar", {
		description: "Edit and save the latest agent response under docs/planning",
		handler: async (_args, ctx) => {
			const text = lastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No agent response found", "warning");
				return;
			}
			await editResponseInNvim(text, ctx);
		},
	});

	pi.registerCommand("telescope-tree-navigate", {
		description: "Internal: navigate to a Telescope tree result",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id || !ctx.sessionManager.getEntry(id)) {
				ctx.ui.notify("Telescope tree entry no longer exists", "warning");
				return;
			}
			await ctx.navigateTree(id, { summarize: false });
		},
	});

	pi.registerCommand("telescope-session-switch", {
		description: "Internal: switch to a Telescope session result",
		handler: async (args, ctx) => {
			let path: string;
			try {
				path = decodeURIComponent(args.trim());
			} catch {
				ctx.ui.notify("Invalid Telescope session path", "warning");
				return;
			}
			if (!path) {
				ctx.ui.notify("Missing Telescope session path", "warning");
				return;
			}
			await ctx.switchSession(path);
		},
	});
}
