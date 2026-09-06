/**
 * tmux-window.ts — Create and manage tmux windows that host child agent Pi
 * sessions. Each approved agent launch gets its own detached tmux window
 * running `node child-host.mjs <launch-spec>`, which boots a native Pi
 * InteractiveMode over the persistent agent session.
 *
 * Windows are always addressed by their STABLE window id (e.g. "@2"), never
 * by the mutable numeric index — the user's tmux config has
 * `renumber-windows on`, so indices shift when windows close.
 */

import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentWindowInfo } from "./types.js";

export { agentWindowName, parentWindowName } from "./names.js";

/** Minimal exec surface (pi.exec is compatible; tests inject a mock). */
export type TmuxExec = (args: string[]) => Promise<ExecResult>;

/** Shell-quote a single argument for the tmux command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Find the current tmux session id (e.g. "$0"). Returns undefined outside tmux. */
export async function currentTmuxSession(exec: TmuxExec): Promise<string | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return undefined;
  const result = await exec(["display-message", "-p", "-t", pane, "#{session_id}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** List windows of a session: [{id, index, name}]. */
export async function listWindows(exec: TmuxExec, session: string): Promise<{ id: string; index: number; name: string }[]> {
  const result = await exec(["list-windows", "-t", session, "-F", "#{window_id} #{window_index} #{window_name}"]);
  if (result.code !== 0) return [];
  const out: { id: string; index: number; name: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^(@\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
    if (match) out.push({ id: match[1]!, index: Number(match[2]), name: match[3] ?? "" });
  }
  return out;
}

/** Largest numeric window index in the session, or 0 when none. */
export function maxWindowIndex(windows: { index: number }[]): number {
  return windows.reduce((max, w) => Math.max(max, w.index), 0);
}

export interface CreateWindowOptions {
  name: string;
  cwd: string;
  command: string;
  agentId?: string;
}

/**
 * Create a detached tmux window at max(window index)+1 running `command`.
 * Returns the stable window id and its numeric index.
 */
export async function createAgentWindow(
  exec: TmuxExec,
  session: string,
  options: CreateWindowOptions,
): Promise<{ id: string; index: number; name: string }> {
  const windows = await listWindows(exec, session);
  const index = maxWindowIndex(windows) + 1;
  const shell = `${options.command}`;
  const created = await exec([
    "new-window", "-d", "-t", session, "-n", options.name, "-c", options.cwd,
    "-P", "-F", "#{window_id} #{window_index}", shell,
  ]);
  if (created.code !== 0) {
    throw new Error(`tmux new-window failed (code ${created.code}): ${created.stderr.trim() || created.stdout.trim()}`);
  }
  const match = /^(@\d+)\s+(\d+)$/.exec(created.stdout.trim().split("\n")[0] ?? "");
  if (!match) {
    throw new Error(`tmux new-window returned an unexpected id format: ${created.stdout.trim()}`);
  }
  // Keep the window name stable (tmux automatic-rename would rewrite it).
  await exec(["set-window-option", "-t", match[1]!, "automatic-rename", "off"]);
  if (options.agentId) {
    await exec(["set-window-option", "-t", match[1]!, AGENT_ID_WINDOW_OPTION, options.agentId]);
  }
  return { id: match[1]!, index: Number(match[2]), name: options.name };
}

/** Focus an existing window by stable id. Returns false when it no longer exists. */
export async function focusWindow(exec: TmuxExec, windowId: string): Promise<boolean> {
  const result = await exec(["select-window", "-t", windowId]);
  return result.code === 0;
}

/** Check whether a window still exists. */
export async function windowAlive(exec: TmuxExec, windowId: string): Promise<boolean> {
  // display-message accepts exactly ONE argument (the format) — the target
  // must come before it: `display-message -p -t <id> <format>`. Putting -t
  // after the format makes tmux error "too many arguments", which would
  // report a LIVE window as dead (and trigger duplicate agent windows).
  // Also: tmux exits 0 with EMPTY output for a nonexistent target, so the
  // returned window id must match too.
  const result = await exec(["display-message", "-p", "-t", windowId, "#{window_id}"]);
  return result.code === 0 && result.stdout.trim() === windowId;
}

/** Kill a window by stable id. Returns false when it no longer exists. */
export async function killWindow(exec: TmuxExec, windowId: string): Promise<boolean> {
  const result = await exec(["kill-window", "-t", windowId]);
  return result.code === 0;
}

/** Current window name of the pane we run in. */
export async function currentWindowName(exec: TmuxExec): Promise<string | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return undefined;
  const result = await exec(["display-message", "-p", "-t", pane, "#{window_name}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Current window id of the pane we run in (used for focus restoration). */
export async function currentWindowId(exec: TmuxExec): Promise<string | undefined> {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return undefined;
  const result = await exec(["display-message", "-p", "-t", pane, "#{window_id}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Marker used to find a parent Pi window after the parent process exits. */
export const PARENT_SESSION_WINDOW_OPTION = "@olive-parent-session-file";
export const PARENT_PROCESS_WINDOW_OPTION = "@olive-parent-pid";
export const AGENT_ID_WINDOW_OPTION = "@olive-agent-id";

/** Mark the current tmux window as hosting a live parent Pi session. */
export async function markParentWindow(exec: TmuxExec, sessionFile: string | undefined): Promise<boolean> {
  if (!sessionFile) return false;
  const windowId = await currentWindowId(exec);
  if (!windowId) return false;
  const marked = await exec(["set-window-option", "-t", windowId, PARENT_SESSION_WINDOW_OPTION, sessionFile]);
  const pid = await exec(["set-window-option", "-t", windowId, PARENT_PROCESS_WINDOW_OPTION, String(process.pid)]);
  return marked.code === 0 && pid.code === 0;
}

/** Clear the parent marker when the Pi process shuts down normally. */
export async function clearParentWindow(exec: TmuxExec): Promise<boolean> {
  const windowId = await currentWindowId(exec);
  if (!windowId) return false;
  const session = await exec(["set-window-option", "-t", windowId, "-u", PARENT_SESSION_WINDOW_OPTION]);
  const pid = await exec(["set-window-option", "-t", windowId, "-u", PARENT_PROCESS_WINDOW_OPTION]);
  return session.code === 0 && pid.code === 0;
}

/** Find a window marked as hosting the specified parent session. */
export async function findParentWindow(
  exec: TmuxExec,
  sessionFile: string,
): Promise<{ id: string; session: string; index: number; name: string } | undefined> {
  const result = await exec(["list-windows", "-a", "-F", `#{window_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{${PARENT_SESSION_WINDOW_OPTION}}`]);
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.split("\n")) {
    const [id, session, index, name, markedFile] = line.split("\t");
    if (markedFile === sessionFile && id && session && index && name !== undefined) {
      return { id, session, index: Number(index), name };
    }
  }
  return undefined;
}

/** Convenience binding for extension code holding a pi instance. */
export function execFromPi(pi: Pick<ExtensionAPI, "exec">): TmuxExec {
  return (args: string[]) => pi.exec("tmux", args);
}

/** Build the tmux window info from a fresh creation result. */
export function toWindowInfo(id: string, index: number, name: string): AgentWindowInfo {
  return { id, index, name, state: "starting" };
}

/**
 * Find a live window by its (stable, automatic-rename-off) name. Returns the
 * window when found, undefined otherwise. Used to dedupe /ot reopens against
 * windows still alive in a previous/target tmux session listing.
 */
export async function findWindowByName(exec: TmuxExec, name: string): Promise<{ id: string; index: number; name: string } | undefined> {
  const result = await exec(["list-windows", "-F", "#{window_id}\t#{window_index}\t#{window_name}"]);
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.split("\n")) {
    const [id, index, windowName] = line.split("\t");
    if (windowName === name && id && index) return { id, index: Number(index), name };
  }
  return undefined;
}

/** Find a child window by its stable identity, independent of its label. */
export async function findWindowByAgentId(exec: TmuxExec, agentId: string): Promise<{ id: string; index: number; name: string } | undefined> {
  const result = await exec(["list-windows", "-F", `#{window_id}\t#{window_index}\t#{window_name}\t#{${AGENT_ID_WINDOW_OPTION}}`]);
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.split("\n")) {
    const [id, index, name, markedId] = line.split("\t");
    if (markedId === agentId && id && index && name !== undefined) return { id, index: Number(index), name };
  }
  return undefined;
}
