import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function resolvePlanningPath(cwd: string, input: string): string | undefined {
	const raw = input.trim();
	if (!raw || raw === "." || raw === ".." || raw.includes("/") || raw.includes("\\")) {
		return undefined;
	}
	const filename = extname(raw) ? raw : `${raw}.md`;
	return resolve(cwd, "docs", "planning", filename);
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

	const targetPath = resolvePlanningPath(ctx.cwd, input);
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

	mkdirSync(resolve(ctx.cwd, "docs", "planning"), { recursive: true });
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
