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

export { agentWindowName } from "./names.js";

/** Minimal exec surface (pi.exec is compatible; tests inject a mock). */
export type TmuxExec = (args: string[]) => Promise<ExecResult>;

/** Shell-quote a single argument for the tmux command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Find the current tmux session id (e.g. "$0"). Returns undefined outside tmux. */
export async function currentTmuxSession(exec: TmuxExec): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await exec(["display-message", "-p", "#{session_id}"]);
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

/** Current window id of the pane we run in (used for focus restoration). */
export async function currentWindowId(exec: TmuxExec): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await exec(["display-message", "-p", "#{window_id}"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Convenience binding for extension code holding a pi instance. */
export function execFromPi(pi: Pick<ExtensionAPI, "exec">): TmuxExec {
  return (args: string[]) => pi.exec("tmux", args);
}

/** Build the tmux window info from a fresh creation result. */
export function toWindowInfo(id: string, index: number, name: string): AgentWindowInfo {
  return { id, index, name, state: "starting" };
}
