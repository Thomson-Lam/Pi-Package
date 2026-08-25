import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";

export function resolvePlanningPath(
	cwd: string,
	input: string,
	directory = "docs/planning",
): string | undefined {
	const raw = input.trim();
	if (!raw || raw === "." || raw === ".." || raw.includes("/") || raw.includes("\\")) {
		return undefined;
	}
	const filename = extname(raw) ? raw : `${raw}.md`;
	const targetPath = resolve(cwd, directory, filename);
	const relativePath = relative(cwd, targetPath);
	return relativePath.startsWith("..") || isAbsolute(relativePath) ? undefined : targetPath;
}

async function selectResponseDirectory(ctx: ExtensionContext): Promise<string | undefined> {
	const items: SelectItem[] = [
		{ value: "default", label: "Default path", description: "docs/planning" },
		{ value: "custom", label: "Custom path", description: "Choose another project directory" },
	];
	const choice = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose save path")), 1, 0));
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
		};
	});

	if (choice === null) return undefined;
	if (choice === "default") return "docs/planning";

	const customPath = await ctx.ui.input("Custom save path", "project-relative directory");
	if (customPath === undefined) return undefined;
	const raw = customPath.trim();
	if (!raw || isAbsolute(raw) || raw.includes("\\") || raw.split("/").includes("..")) {
		ctx.ui.notify("Enter a valid project-relative directory", "warning");
		return undefined;
	}
	const resolved = resolve(ctx.cwd, raw);
	const relativePath = relative(ctx.cwd, resolved);
	return relativePath.startsWith("..") || isAbsolute(relativePath) ? undefined : relativePath;
}

export async function editResponseInNvim(
	text: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Opening Neovim requires Pi TUI mode", "error");
		return;
	}

	const input = await ctx.ui.input(
		"Save agent response",
		"filename.md (saved under docs/planning)",
	);
	if (input === undefined) return;

	const directory = await selectResponseDirectory(ctx);
	if (directory === undefined) return;

	const targetPath = resolvePlanningPath(ctx.cwd, input, directory);
	if (!targetPath) {
		ctx.ui.notify("Enter a file name without directories", "warning");
		return;
	}

	const existed = existsSync(targetPath);
	let previousContent: string | undefined;
	if (existed) {
		const overwrite = await ctx.ui.confirm(
			"Replace existing file?",
			targetPath,
		);
		if (!overwrite) return;
		try {
			previousContent = readFileSync(targetPath, "utf8");
		} catch {}
	}

	mkdirSync(resolve(ctx.cwd, directory), { recursive: true });
	const runtimeDir = mkdtempSync(join(tmpdir(), "pi-telescope-response-"));
	const sourcePath = join(runtimeDir, "response.md");
	writeFileSync(sourcePath, text, "utf8");

	try {
		const result = await ctx.ui.custom<{ code: number | null; error?: string } | null>(
			(tui, _theme, _keybindings, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");
				let outcome: { code: number | null; error?: string };
				try {
					const loadResponse = [
						`local lines = vim.fn.readfile(${JSON.stringify(sourcePath)})`,
						"vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)",
						'vim.bo.filetype = "markdown"',
						"vim.bo.modified = true",
					].join("; ");
					const child = spawnSync("nvim", ["-c", `lua ${loadResponse}`, targetPath], {
						cwd: ctx.cwd,
						stdio: "inherit",
						env: process.env,
					});
					outcome = { code: child.status, error: child.error?.message };
				} catch (error) {
					outcome = {
						code: null,
						error: error instanceof Error ? error.message : String(error),
					};
				} finally {
					tui.start();
					tui.requestRender(true);
				}
				done(outcome);
				return { render: () => [], invalidate: () => {} };
			},
		);

		if (result?.error) {
			ctx.ui.notify(`Could not open Neovim: ${result.error}`, "error");
			return;
		}
		if (result && result.code !== 0) {
			ctx.ui.notify(`Neovim exited with code ${result.code}`, "warning");
			return;
		}

		if (!existsSync(targetPath)) {
			ctx.ui.notify("Neovim closed without saving the response", "info");
			return;
		}
		const currentContent = readFileSync(targetPath, "utf8");
		if (existed && currentContent === previousContent) {
			ctx.ui.notify("Neovim closed without changing the file", "info");
			return;
		}
		ctx.ui.notify(`Saved ${targetPath}`, "info");
	} finally {
		rmSync(runtimeDir, { recursive: true, force: true });
	}
}
