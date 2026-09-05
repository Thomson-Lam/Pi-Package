/**
 * event-mailbox.ts — Dependency-free filesystem mailbox between the parent Pi
 * session and child agent Pi sessions (each child runs in its own tmux window).
 *
 * Layout (all paths under <mailboxDir>):
 *   events/     child → parent   (atomic JSON files, consumed by the parent)
 *   commands/   parent → child   (atomic JSON files, polled by child-host.mjs)
 *
 * Conventions:
 *   - directories are 0700, files are 0600
 *   - writes go to a temp name then rename() (atomic on POSIX)
 *   - the parent re-scans the directory after every fs.watch event, because
 *     watch events are not guaranteed one-per-file
 *   - malformed files are ignored (and removed) so one bad write cannot wedge
 *     the mailbox
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextReturnCheckpoint } from "./context-ledger.js";

export interface LifetimeUsageReport { input: number; output: number; cacheWrite: number }

export interface PendingDecisionState {
  runNumber: number;
  reason: "completed" | "turn_limit" | "aborted";
  result?: string;
  turnCount: number;
  maxTurns?: number;
  toolUses: number;
  requestedAt: number;
  compactions?: number;
  usage?: LifetimeUsageReport;
}

export interface ChildEventMap {
  ready: { sessionId: string; sessionFile?: string };
  run_started: { runNumber: number; maxTurns?: number; mode?: "automatic" | "interactive" };
  tool_started: { runNumber?: number; toolName: string; target?: string };
  tool_finished: { runNumber?: number; toolName: string };
  turn_finished: { runNumber?: number; turnCount: number };
  run_idle: { runNumber: number; reason: "completed" | "turn_limit" | "interrupted"; turnCount: number; toolUses: number; maxTurns?: number };
  decision_required: PendingDecisionState;
  context_checkpoint: { runNumber: number; checkpoint: ContextReturnCheckpoint };
  run_settled: {
    runNumber: number;
    status: "completed" | "steered" | "aborted" | "stopped" | "error";
    result?: string;
    error?: string;
    turnCount: number;
    toolUses: number;
    compactions?: number;
    /** Explicit release or an unrecoverable stop/error. */
    releaseReason?: "human_return" | "error";
    decisionReason?: "completed" | "turn_limit" | "aborted";
    /** Session token totals as reported by the child (resets at compaction, like pi's footer). */
    usage?: LifetimeUsageReport;
  };
  process_exit: {};
}


export type ChildEvent = { [K in keyof ChildEventMap]: { type: K } & ChildEventMap[K] }[keyof ChildEventMap];

export interface ParentCommandMap {
  ack_checkpoint: { checkpointId: string };
}

export type ParentCommand = { [K in keyof ParentCommandMap]: { type: K } & ParentCommandMap[K] }[keyof ParentCommandMap];

/** Create the mailbox directory structure. Idempotent. */
export function ensureMailboxDir(mailboxDir: string): void {
  for (const sub of ["", "events", "commands"]) {
    const dir = sub ? join(mailboxDir, sub) : mailboxDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

/** Remove the whole mailbox directory. */
export function removeMailboxDir(mailboxDir: string): void {
  rmSync(mailboxDir, { recursive: true, force: true });
}

let seq = 0;
function nextSeq(): string {
  seq = (seq + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** Write a JSON file atomically (temp + rename) with 0600 permissions. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${nextSeq()}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, filePath);
}

// ---- Child side ----

/** Emit a child→parent event. Returns the file path written. */
export function emitChildEvent(mailboxDir: string, event: ChildEvent): string {
  ensureMailboxDir(mailboxDir);
  const file = join(mailboxDir, "events", `${nextSeq()}-${event.type}.json`);
  writeJsonAtomic(file, event);
  return file;
}

/** Write a parent→child command. Returns the file path written. */
export function writeParentCommand(mailboxDir: string, command: ParentCommand): string {
  ensureMailboxDir(mailboxDir);
  const file = join(mailboxDir, "commands", `${nextSeq()}-${command.type}.json`);
  writeJsonAtomic(file, command);
  return file;
}

const PENDING_DECISION_FILE = "pending-decision.json";

export function writePendingDecision(mailboxDir: string, state: PendingDecisionState): void {
  ensureMailboxDir(mailboxDir);
  writeJsonAtomic(join(mailboxDir, PENDING_DECISION_FILE), state);
}

export function readPendingDecision(mailboxDir: string): PendingDecisionState | undefined {
  try {
    const value = JSON.parse(readFileSync(join(mailboxDir, PENDING_DECISION_FILE), "utf-8")) as PendingDecisionState;
    if (!value || typeof value.runNumber !== "number" || !["completed", "turn_limit", "aborted"].includes(value.reason)) return undefined;
    return value;
  } catch { return undefined; }
}

export function clearPendingDecision(mailboxDir: string): void {
  try { rmSync(join(mailboxDir, PENDING_DECISION_FILE), { force: true }); } catch { /* best effort */ }
}

/** Read all pending commands (oldest first). Does not delete them. */
export function readPendingCommands(mailboxDir: string): ParentCommand[] {
  const dir = join(mailboxDir, "commands");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: ParentCommand[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8")) as ParentCommand;
      if (raw && typeof raw.type === "string") out.push(raw);
    } catch { /* malformed — skip, will be cleaned up below */ }
  }
  return out;
}

/** Delete command files that have been consumed (by exact path). */
export function ackCommand(mailboxDir: string, file: string): void {
  rmSync(join(mailboxDir, "commands", file), { force: true });
}

/**
 * List and delete ALL consumed command files (idempotent). The child host
 * calls this after processing every command it read, so a crashed host cannot
 * replay stale commands on restart (each launch spec is one-shot anyway).
 */
export function clearConsumedCommands(mailboxDir: string, consumed: string[]): void {
  for (const file of consumed) ackCommand(mailboxDir, file);
}

// ---- Parent side ----

/**
 * Read all pending child events (oldest first) and atomically consume them
 * (read + delete). Returns the events. Malformed files are deleted.
 */
export function consumeChildEvents(mailboxDir: string): ChildEvent[] {
  const dir = join(mailboxDir, "events");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: ChildEvent[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as ChildEvent;
      if (raw && typeof raw.type === "string") out.push(raw);
      rmSync(path, { force: true });
    } catch {
      // Malformed or unreadable — remove so it cannot wedge the mailbox.
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  return out;
}

export interface EventWatcher {
  /** Stop watching and remove listeners. */
  dispose(): void;
  /** Force a rescan (used as a polling fallback). */
  refresh(): void;
}

/**
 * Watch a mailbox for child events. Performs an immediate scan, then rescans
 * after every fs.watch event (debounced). onEvents receives every event found;
 * the caller is responsible for deduplication (events are consumed here).
 */
export function watchChildEvents(
  mailboxDir: string,
  onEvents: (events: ChildEvent[]) => void,
  debounceMs = 100,
): EventWatcher {
  ensureMailboxDir(mailboxDir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const scan = () => {
    if (disposed) return;
    const events = consumeChildEvents(mailboxDir);
    if (events.length > 0) {
      try { onEvents(events); } catch { /* observer errors must not break the watcher */ }
    }
  };

  // Initial scan — recovers events written before the watcher started.
  scan();

  const watcher = (() => {
    try {
      return watch(join(mailboxDir, "events"), () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(scan, debounceMs);
      });
    } catch {
      return undefined; // watcher unavailable — rely on polling via refresh()
    }
  })();

  return {
    /** Force a rescan (used as a polling fallback). */
    refresh: scan,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch { /* ignore */ }
    },
  };
}
