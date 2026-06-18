import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function openInEditor(filePath: string): Promise<{ opened: boolean; reason?: string }> {
  if (!process.env.TMUX) {
    return { opened: false, reason: "Not running inside tmux" };
  }

  const fullPath = path.resolve(filePath);
  const command = `sh -lc ${shellQuote(`nvim ${shellQuote(fullPath)}; tmux kill-pane`)}`;
  await execFileAsync("tmux", ["split-window", "-h", command]);
  return { opened: true };
}
