import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PARENT_SESSION_WINDOW_OPTION = "@olive-parent-session-file";
const PARENT_PROCESS_WINDOW_OPTION = "@olive-parent-pid";

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function tmux(args) {
  try {
    const result = await execFileAsync("tmux", args, { encoding: "utf8" });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { code: error?.code ?? 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? String(error) };
  }
}

function markedParentWindow(output, sessionFile) {
  for (const line of output.split("\n")) {
    const [id, , , , markedFile, markedPid] = line.split("\t");
    if (!id || markedFile !== sessionFile || !/^\d+$/.test(markedPid ?? "")) continue;
    try {
      process.kill(Number(markedPid), 0);
      return id;
    } catch {}
  }
  return undefined;
}

/** Focus an existing parent window, or open the parent session in a new one. */
export async function focusOrOpenParent({ parentSessionFile, cwd }, exec = tmux) {
  if (!parentSessionFile) return "unavailable";

  const listed = await exec([
    "list-windows", "-a", "-F",
    `#{window_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{${PARENT_SESSION_WINDOW_OPTION}}\t#{${PARENT_PROCESS_WINDOW_OPTION}}`,
  ]);
  if (listed.code === 0) {
    const existing = markedParentWindow(listed.stdout, parentSessionFile);
    if (existing) {
      const focused = await exec(["select-window", "-t", existing]);
      if (focused.code === 0) return "focused";
    }
  }

  const session = await exec(["display-message", "-p", "#{session_id}"]);
  if (session.code !== 0 || !session.stdout.trim()) return "unavailable";

  const created = await exec([
    "new-window", "-d", "-t", session.stdout.trim(), "-n", "[P] parent",
    "-c", cwd, "-P", "-F", "#{window_id}", "pi --session " + quote(parentSessionFile),
  ]);
  if (created.code !== 0) return "unavailable";

  const windowId = created.stdout.trim().split(/\s+/)[0];
  if (!windowId) return "opened";
  const focused = await exec(["select-window", "-t", windowId]);
  return focused.code === 0 ? "opened" : "unavailable";
}

export { PARENT_PROCESS_WINDOW_OPTION, PARENT_SESSION_WINDOW_OPTION };
