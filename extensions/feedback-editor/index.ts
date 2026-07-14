import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const clientScript = join(dirname(fileURLToPath(import.meta.url)), "client.lua");
const adjectives = ["brisk", "calm", "clever", "merry", "quiet", "swift"];
const nouns = ["badger", "falcon", "otter", "raven", "tiger", "willow"];

function bufferName(): string {
  return `${adjectives[randomInt(adjectives.length)]}-${nouns[randomInt(nouns.length)]}.md`;
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
    if (text) return text;
  }
}

async function editInPane(pi: ExtensionAPI, ctx: ExtensionCommandContext, initialText: string): Promise<string | undefined> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "pi-feedback-"));
  const socketPath = join(runtimeDir, "editor.sock");
  const bufferPath = join(runtimeDir, bufferName());
  let client: Socket | undefined;
  let pane = "";

  let settle!: (text: string | undefined) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<string | undefined>((resolve, reject) => { settle = resolve; fail = reject; });
  void result.catch(() => undefined);
  const timeout = setTimeout(() => fail(new Error("Neovim did not connect within 5 seconds.")), 5000);

  const server = createServer((socket) => {
    if (client) return socket.destroy();
    client = socket;
    clearTimeout(timeout);
    socket.write(`${JSON.stringify({ text: initialText })}\n`);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      try { settle(JSON.parse(pending.slice(0, newline)).text); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("close", () => settle(undefined));
    socket.on("error", fail);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const opened = await pi.exec("tmux", [
      "split-window", "-d", "-h", "-f", "-l", "50%", "-t", process.env.TMUX_PANE!,
      "-c", ctx.cwd, "-P", "-F", "#{pane_id}",
      `PI_FEEDBACK_SOCKET=${shellQuote(socketPath)} exec nvim -n ${shellQuote(bufferPath)} -S ${shellQuote(clientScript)}`,
    ]);
    if (opened.code !== 0) throw new Error(opened.stderr.trim() || "tmux could not open the feedback pane.");
    pane = opened.stdout.trim();
    await pi.exec("tmux", ["select-pane", "-t", pane]);
    return await result;
  } finally {
    clearTimeout(timeout);
    client?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pane) await pi.exec("tmux", ["kill-pane", "-t", pane]).catch(() => undefined);
    await pi.exec("tmux", ["select-pane", "-t", process.env.TMUX_PANE!]).catch(() => undefined);
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export default function feedbackEditor(pi: ExtensionAPI): void {
  let editing = false;

  const run = async (ctx: ExtensionCommandContext, initialText: string) => {
    if (ctx.mode !== "tui" || !process.env.TMUX || !process.env.TMUX_PANE) {
      ctx.ui.notify("Feedback editor requires Pi TUI mode inside tmux.", "error");
      return;
    }
    if (editing) {
      ctx.ui.notify("A feedback editor is already open.", "warning");
      return;
    }
    editing = true;
    try {
      const text = await editInPane(pi, ctx, initialText);
      if (text !== undefined) {
        ctx.ui.setEditorText(text);
        ctx.ui.notify("Feedback loaded into the chat editor.", "info");
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      editing = false;
    }
  };

  pi.registerCommand("fb", {
    description: "Write feedback in Neovim",
    handler: async (_args, ctx) => run(ctx, ""),
  });

  pi.registerCommand("fpr", {
    description: "Edit the last assistant response in Neovim",
    handler: async (_args, ctx) => {
      const response = lastAssistantText(ctx);
      if (!response) return ctx.ui.notify("No assistant response found.", "error");
      await run(ctx, response);
    },
  });
}
