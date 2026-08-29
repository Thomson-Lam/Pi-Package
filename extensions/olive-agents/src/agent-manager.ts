/**
 * agent-manager.ts — Coordinates child agent Pi sessions running in tmux
 * windows. The parent no longer owns an in-process AgentSession; instead each
 * child runs a native Pi TUI over a persistent session, and the manager:
 *
 *   - prepares launch specs and creates tmux windows (concurrency-queued)
 *   - watches each child's mailbox for lifecycle/tool events
 *   - forwards commands (follow_up / abort / shutdown) to the child
 *   - tracks per-record status, activity, usage and window state
 *
 * Foreground spawns bypass the concurrency queue and await run_settled.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentLaunchSpec, normalizeMaxTurns, prepareAgentLaunch, writeLaunchSpec } from "./agent-runner.js";
import { type ChildEvent, ensureMailboxDir, removeMailboxDir, watchChildEvents, writeParentCommand } from "./event-mailbox.js";
import { createAgentWindow, execFromPi, focusWindow as focusTmuxWindow, killWindow as killTmuxWindow, shellQuote, windowAlive as tmuxWindowAlive, type TmuxExec } from "./tmux-window.js";
import { agentSessionName, agentWindowName } from "./names.js";
import { type AgentRecord, type SubagentType, type ThinkingLevel } from "./types.js";

/** Tool activity callback (kept for foreground streaming compatibility). */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
  input?: unknown;
}

export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  invocation?: AgentRecord["invocation"];
  onToolActivity?: (activity: ToolActivity) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export type AgentManagerEvent =
  | { type: "created"; record: AgentRecord }
  | { type: "started"; record: AgentRecord }
  | { type: "updated"; record: AgentRecord }
  | { type: "completed"; record: AgentRecord }
  | { type: "reviewed"; record: AgentRecord }
  | { type: "removed"; id: string };

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: { reason: string; tokensBefore: number }) => void;
export type OnAgentReady = (record: AgentRecord, identity: NonNullable<AgentRecord["childSession"]>) => void;
export type OnHumanSteer = (record: AgentRecord, text: string) => void;

/** Injectable side-effect surface (tests provide mocks). */
export interface ManagerDeps {
  tmux: TmuxExec;
  /** Prepare the launch spec. Defaults to the real implementation. */
  prepare: (input: Parameters<typeof prepareAgentLaunch>[0]) => Promise<{ spec: AgentLaunchSpec; warnings: string[] }>;
  /** Build the child command line for a launch spec path. */
  childCommand: (specPath: string) => string;
}

const DEFAULT_MAX_CONCURRENT = 2;
/** Give a starting child this long to report ready before declaring launch failure. */
const STARTUP_WATCHDOG_MS = 30_000;
/** Window liveness poll interval while a record has a window. */
const WINDOW_POLL_MS = 15_000;

/** Human-readable tool action label. */
function actionFor(toolName: string): string {
  switch (toolName) {
    case "read": return "reading";
    case "bash": return "running command";
    case "edit": return "editing";
    case "write": return "writing";
    case "grep": return "searching";
    case "find": return "finding files";
    case "ls": return "listing";
    default: return toolName;
  }
}

/** Default child command line: `node <child-host.mjs> <specPath>`. */
function defaultChildCommand(specPath: string): string {
  const hostPath = new URL("./child-host.mjs", import.meta.url).pathname;
  return `${shellQuote(process.execPath)} ${shellQuote(hostPath)} ${shellQuote(specPath)}`;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private listeners = new Set<(event: AgentManagerEvent) => void>();
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onReady?: OnAgentReady;
  private onHumanSteer?: OnHumanSteer;
  private maxConcurrent: number;
  private queue: { id: string; args: { pi: ExtensionAPI; ctx: ExtensionContext; type: SubagentType; prompt: string; options: SpawnOptions } }[] = [];
  private runningBackground = 0;
  private deps: ManagerDeps;
  private watchers = new Map<string, ReturnType<typeof watchChildEvents>>();
  private windowTimers = new Map<string, ReturnType<typeof setInterval>>();
  private settled = new Map<string, { promise: Promise<AgentRecord>; resolve: (r: AgentRecord) => void }>();
  private readyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  /** Close an agent's tmux window as soon as its run settles (unless focused). */
  closeWindowOnComplete = true;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    deps?: Partial<ManagerDeps>,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    this.deps = {
      tmux: execFromPi({ exec: async () => ({ code: 1, stdout: "", stderr: "no pi exec available", killed: false }) }),
      prepare: prepareAgentLaunch,
      childCommand: defaultChildCommand,
      ...deps,
    };
  }

  /** Callback wiring (set after construction to avoid long constructor args). */
  setCallbacks(cb: { onReady?: OnAgentReady; onHumanSteer?: OnHumanSteer }): void {
    if (cb.onReady) this.onReady = cb.onReady;
    if (cb.onHumanSteer) this.onHumanSteer = cb.onHumanSteer;
  }

  /** Toggle window auto-close on run completion. */
  setCloseWindowOnComplete(b: boolean): void {
    this.closeWindowOnComplete = b;
  }

  subscribe(listener: (event: AgentManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentManagerEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* UI observers must not break lifecycle */ }
    }
  }

  markReviewed(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || record.status === "running" || record.status === "queued") return false;
    record.reviewedAt = Date.now();
    record.updatedAt = record.reviewedAt;
    this.emit({ type: "reviewed", record });
    return true;
  }

  removeTerminal(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || record.status === "running" || record.status === "queued") return false;
    this.removeRecord(id, record);
    return true;
  }

  /** Update the max concurrent background agent limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    void this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent session and return its ID. If the concurrency limit is
   * reached, the launch (and its tmux window) waits in the queue.
   */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): Promise<string> {
    const id = randomUUID().slice(0, 17);
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      originalPrompt: prompt,
      effectivePrompt: prompt,
      updatedAt: Date.now(),
      runNumber: 0,
      turnCount: 0,
      maxTurns: normalizeMaxTurns(options.maxTurns),
      isBackground: options.isBackground,
      invocation: options.invocation,
    };
    this.agents.set(id, record);
    this.emit({ type: "created", record });

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ id, args: { pi, ctx, type, prompt, options } });
      return id;
    }

    try {
      await this.startAgent(id, { pi, ctx, type, prompt, options });
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent: prepare spec, create tmux window, watch mailbox. */
  private async startAgent(
    id: string,
    { pi, ctx, type, prompt, options }: { pi: ExtensionAPI; ctx: ExtensionContext; type: SubagentType; prompt: string; options: SpawnOptions },
  ): Promise<void> {
    const record = this.agents.get(id);
    if (!record || this.disposed) return;

    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    // May be undefined when the parent runs with --no-session; the child then
    // persists under its own cwd's default session dir and appears as a root
    // session in /resume (no nesting possible).
    const sessionDir = ctx.sessionManager.getSessionDir();
    const mailboxDir = join(tmpdir(), "olive-agents", parentSessionId ?? "session", id);
    record.mailboxDir = mailboxDir;
    ensureMailboxDir(mailboxDir);

    const childSessionId = randomUUID();
    const model = options.model ?? ctx.model;
    if (!model) throw new Error("No effective model available for agent launch.");
    const { spec, warnings } = await this.deps.prepare({
      pi,
      ctx,
      type,
      prompt,
      description: options.description,
      options: {
        model,
        thinking: options.thinkingLevel,
        maxTurns: options.maxTurns,
      },
      agentId: id,
      childSessionId,
      parentSessionFile,
      sessionDir,
      mailboxDir,
    });

    for (const warning of warnings) {
      try { ctx.ui.notify(`Agent "${type}": ${warning}`, "warning"); } catch { /* ignore */ }
    }

    // Record the child session identity up front (sessionFile arrives via ready).
    record.childSession = {
      sessionId: childSessionId,
      sessionName: spec.session.name,
      parentSessionFile,
    };
    record.launchSpec = spec;

    const specPath = join(mailboxDir, "launch.json");
    writeLaunchSpec(specPath, spec);

    // tmux session lookup — must be inside tmux.
    const exec = this.deps.tmux;
    const sessionResult = await exec(["display-message", "-p", "#{session_id}"]);
    if (sessionResult.code !== 0) {
      throw new Error("Agent sessions require tmux: launch pi inside a tmux session (this workflow is tmux-first).");
    }
    const tmuxSession = sessionResult.stdout.trim();

    const command = this.deps.childCommand(specPath);
    const created = await createAgentWindow(exec, tmuxSession, {
      name: agentWindowName(id, type),
      cwd: spec.runtime.cwd,
      command,
    });

    record.window = { id: created.id, index: created.index, name: created.name, state: "starting" };
    record.startedAt = Date.now();
    record.updatedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);
    this.emit({ type: "started", record });

    // Wire parent abort signal.
    if (options.signal) {
      const onParentAbort = () => { void this.abort(id); };
      options.signal.addEventListener("abort", onParentAbort, { once: true });
    }

    // Watch the child mailbox.
    const watcher = watchChildEvents(mailboxDir, (events) => {
      for (const event of events) this.handleChildEvent(id, event, options);
    });
    this.watchers.set(id, watcher);

    // Startup watchdog: if the child never reports ready, fail the launch.
    const readyTimer = setTimeout(() => {
      const rec = this.agents.get(id);
      if (rec && rec.status === "queued" && !rec.childSession?.sessionFile) {
        this.failLaunch(id, "child agent did not report ready (window may have failed to start)");
      }
    }, STARTUP_WATCHDOG_MS);
    readyTimer.unref?.();
    this.readyTimers.set(id, readyTimer);

    // Window liveness poll (detects kill-window / manual closes). Also
    // retries the auto-close for terminal records — convergence net if the
    // settle-time close hit a transient tmux failure.
    const poll = setInterval(() => {
      const rec = this.agents.get(id);
      if (!rec?.window || rec.window.state === "closed") return;
      void tmuxWindowAlive(exec, rec.window.id).then((alive) => {
        const r = this.agents.get(id);
        if (!r?.window || r.window.state === "closed") return;
        if (!alive) {
          r.window.state = "closed";
          r.updatedAt = Date.now();
          this.emit({ type: "updated", record: r });
          this.maybeAutoClear(r);
          return;
        }
        // Terminal record whose window is still open — retry the auto-close.
        if (r.status !== "running" && r.status !== "queued") {
          void this.maybeCloseWindow(r);
        }
      });
    }, WINDOW_POLL_MS);
    poll.unref?.();
    this.windowTimers.set(id, poll);
  }

  /** Handle a batch of child events for a record. */
  private handleChildEvent(id: string, event: ChildEvent, options: SpawnOptions): void {
    const record = this.agents.get(id);
    if (!record || this.disposed) return;

    switch (event.type) {
      case "ready": {
        if (record.childSession) record.childSession.sessionFile = event.sessionFile;
        if (record.window) record.window.state = "alive";
        record.status = "running";
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        if (record.childSession) this.onReady?.(record, record.childSession);
        const rt = this.readyTimers.get(id);
        if (rt) { clearTimeout(rt); this.readyTimers.delete(id); }
        break;
      }

      case "run_started": {
        record.status = "running";
        record.runNumber = event.runNumber;
        record.turnCount = 0;
        record.toolUses = 0;
        record.result = undefined;
        record.error = undefined;
        record.completedAt = undefined;
        record.reviewedAt = undefined;
        record.stopReason = undefined;
        record.updatedAt = Date.now();
        this.onStart?.(record);
        this.emit({ type: "started", record });
        break;
      }

      case "tool_started": {
        record.latestActivity = {
          toolName: event.toolName,
          action: actionFor(event.toolName),
          target: event.target,
          startedAt: Date.now(),
        };
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        options.onToolActivity?.({ type: "start", toolName: event.toolName, input: { command: event.target } });
        break;
      }

      case "tool_finished": {
        record.toolUses++;
        if (record.latestActivity?.toolName === event.toolName) {
          record.latestActivity.completedAt = Date.now();
        }
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        options.onToolActivity?.({ type: "end", toolName: event.toolName });
        break;
      }

      case "turn_finished": {
        record.turnCount = event.turnCount;
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        options.onTurnEnd?.(event.turnCount);
        break;
      }

      case "human_steer": {
        record.feedback = { kind: "steer", text: event.text, state: "delivered", updatedAt: Date.now() };
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        this.onHumanSteer?.(record, event.text);
        break;
      }

      case "run_settled": {
        this.applySettled(record, event);
        break;
      }

      case "process_exit": {
        if (record.window) record.window.state = "closed";
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        this.maybeAutoClear(record);
        break;
      }
    }
  }

  /** Apply a run_settled event: terminal status, result, notifications. */
  private applySettled(record: AgentRecord, event: Extract<ChildEvent, { type: "run_settled" }>): void {
    // Status precedence: an external stop stays "stopped"; otherwise the
    // child's own settlement status wins.
    if (record.status !== "stopped") {
      record.status = event.status === "steered" ? "steered" : event.status;
    }
    record.result = event.result;
    if (event.error) record.error = event.error;
    record.completedAt = Date.now();
    record.turnCount = event.turnCount;
    record.toolUses = Math.max(record.toolUses, event.toolUses);
    if (typeof event.compactions === "number") record.compactionCount = event.compactions;
    if (event.usage) record.lifetimeUsage = { ...event.usage };
    record.reviewedAt = undefined;

    record.stopReason =
      record.status === "steered" ? "turn limit"
      : record.status === "aborted" ? "max turns exceeded"
      : record.status === "stopped" ? "stopped by user"
      : record.status === "error" ? (event.error ?? "unknown error")
      : undefined;
    record.updatedAt = Date.now();

    // Resolve any foreground/resume waiter.
    const wait = this.settled.get(record.id);
    if (wait) {
      this.settled.delete(record.id);
      wait.resolve(record);
    }

    if (!record.isBackground) {
      record.resultConsumed = true;
      try { this.onComplete?.(record); } catch { /* ignore */ }
    } else {
      this.runningBackground = Math.max(0, this.runningBackground - 1);
      try { this.onComplete?.(record); } catch { /* ignore */ }
      void this.drainQueue();
    }
    this.emit({ type: "completed", record });
    void this.maybeCloseWindow(record);
  }

  /**
   * Close an agent's tmux window once its run settles — unless the user is
   * actively viewing that window, or a follow-up is queued for it. The Pi
   * session file is unaffected; the window can be reopened on demand.
   */
  private async maybeCloseWindow(record: AgentRecord): Promise<void> {
    try {
      await this.maybeCloseWindowInner(record);
    } catch (err) {
      console.error(`[pi-subagents] auto-close of window ${record.window?.id ?? "?"} failed:`, err instanceof Error ? err.message : err);
    }
  }

  private async maybeCloseWindowInner(record: AgentRecord): Promise<void> {
    if (!this.closeWindowOnComplete) return;
    if (!record.window || record.window.state === "closed") return;
    // A queued parent follow-up is about to use the window — leave it alone.
    if (record.feedback?.kind === "follow-up" && record.feedback.state === "queued") return;

    const exec = this.deps.tmux;
    if (!(await tmuxWindowAlive(exec, record.window.id))) {
      record.window.state = "closed";
      record.updatedAt = Date.now();
      this.emit({ type: "updated", record });
      this.maybeAutoClear(record);
      return;
    }
    // Keep the window open while the user is looking at it.
    const focused = await exec(["display-message", "-p", "#{window_id}"]);
    if (focused.code === 0 && focused.stdout.trim() === record.window.id) return;

    await killTmuxWindow(exec, record.window.id);
    record.window.state = "closed";
    record.updatedAt = Date.now();
    this.emit({ type: "updated", record });
    this.maybeAutoClear(record);
  }

  /**
   * Mark a result as consumed (parent agent read it). Auto-clears the fleet
   * record once the run is terminal AND its window is closed — everything
   * about the agent has then been acknowledged. The Pi session file and the
   * parent session's subagents:record entries remain as the archive.
   */
  consumeResult(id: string): void {
    const record = this.agents.get(id);
    if (!record) return;
    record.resultConsumed = true;
    this.maybeAutoClear(record);
  }

  private maybeAutoClear(record: AgentRecord): void {
    const terminal =
      record.status === "completed" || record.status === "steered" ||
      record.status === "aborted" || record.status === "stopped" || record.status === "error";
    if (!terminal || !record.resultConsumed) return;
    if (record.window && record.window.state !== "closed") return;
    this.removeRecord(record.id, record);
  }

  /**
   * Dismiss a terminal record: close its window (if still open) and forget it.
   * The Pi session file is preserved. Returns false for unknown/active records.
   */
  dismiss(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === "running" || record.status === "queued") return false;
    if (record.window && record.window.state !== "closed") {
      void killTmuxWindow(this.deps.tmux, record.window.id);
      record.window.state = "closed";
    }
    this.removeRecord(id, record);
    return true;
  }

  /** Fail a launch that never became ready. */
  private failLaunch(id: string, message: string): void {
    const record = this.agents.get(id);
    if (!record) return;
    record.status = "error";
    record.error = message;
    record.completedAt = Date.now();
    record.reviewedAt = undefined;
    record.updatedAt = Date.now();
    this.stopWatchers(id);
    const wait = this.settled.get(id);
    if (wait) { this.settled.delete(id); wait.resolve(record); }
    if (record.isBackground) {
      this.runningBackground = Math.max(0, this.runningBackground - 1);
      try { this.onComplete?.(record); } catch { /* ignore */ }
      void this.drainQueue();
    }
    this.emit({ type: "completed", record });
  }

  /** Start queued agents up to the concurrency limit. */
  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        await this.startAgent(next.id, next.args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const record = this.agents.get(next.id);
        record.status = "error";
        record.error = message;
        record.completedAt = Date.now();
        record.updatedAt = Date.now();
        record.reviewedAt = undefined;
        this.stopWatchers(record.id);
        try { this.onComplete?.(record); } catch { /* ignore */ }
        this.emit({ type: "completed", record });
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use). Foreground
   * agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = await this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await this.awaitSettled(id);
    return { id, record };
  }

  /** Arm a promise resolved on the next run_settled for a record. */
  private awaitSettled(id: string): Promise<AgentRecord> {
    const existing = this.settled.get(id);
    if (existing) return existing.promise;
    let resolve!: (r: AgentRecord) => void;
    const promise = new Promise<AgentRecord>((r) => { resolve = r; });
    this.settled.set(id, { promise, resolve });
    return promise;
  }

  /** Public waiter: resolves on the next run_settled for a record (or immediately if already settled). */
  waitForSettled(id: string): Promise<AgentRecord> {
    const record = this.agents.get(id);
    if (record && (record.status === "completed" || record.status === "steered" || record.status === "aborted" || record.status === "stopped" || record.status === "error") && record.completedAt) {
      return Promise.resolve(record);
    }
    return this.awaitSettled(id);
  }

  /**
   * Resume a child agent session with a follow-up prompt. Ensures a live
   * window (reopening the session if the window was closed), sends the
   * follow-up, and awaits the resulting run_settled.
   */
  async resume(
    id: string,
    prompt: string,
    _signal?: AbortSignal,
    options: { model?: Model<any>; thinking?: ThinkingLevel; resultConsumed?: boolean } = {},
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record || record.status === "running" || record.status === "queued") return undefined;
    if (!record.mailboxDir || !record.launchSpec) return undefined;

    // Ensure a live window (reopen the session if the window was closed).
    if (!record.window || record.window.state === "closed") {
      const ok = await this.reopenWindow(id);
      if (!ok) {
        record.error = "could not reopen agent session window";
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        return record;
      }
    }

    // Arm the waiter BEFORE sending the command so a fast child cannot race.
    const wait = this.awaitSettled(id);
    record.effectivePrompt = prompt;
    record.resultConsumed = options.resultConsumed ?? false;
    record.feedback = { kind: "follow-up", text: prompt, state: "queued", updatedAt: Date.now() };
    record.updatedAt = Date.now();
    this.emit({ type: "updated", record });

    writeParentCommand(record.mailboxDir, { type: "follow_up", message: prompt });
    await wait;
    return this.agents.get(id);
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Find a record by its child session file (for /resume guards). */
  recordBySessionFile(sessionFile: string): AgentRecord | undefined {
    const norm = (s: string) => s.replace(/\/+$/, "");
    const target = norm(sessionFile);
    for (const record of this.agents.values()) {
      const f = record.childSession?.sessionFile;
      if (f && norm(f) === target) return record;
    }
    return undefined;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Abort a queued or running child. */
  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.status === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      record.updatedAt = Date.now();
      record.reviewedAt = undefined;
      record.stopReason = "stopped by user";
      this.stopWatchers(id);
      try { this.onComplete?.(record); } catch { /* ignore */ }
      this.emit({ type: "completed", record });
      return true;
    }

    if (record.status !== "running") return false;
    record.status = "stopped";
    record.completedAt = Date.now();
    record.updatedAt = Date.now();
    record.reviewedAt = undefined;
    record.stopReason = "stopped by user";
    this.emit({ type: "updated", record });
    if (record.mailboxDir) {
      writeParentCommand(record.mailboxDir, { type: "abort" });
    }
    return true;
  }

  /** Focus the record's tmux window, reopening the session if closed. */
  async focusOrReopen(id: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status === "queued") return false; // no window yet
    if (record.window && record.window.state !== "closed") {
      // Confirm the window is really alive before trusting our poll — retry
      // once so a transient tmux failure cannot spawn a duplicate child.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await tmuxWindowAlive(this.deps.tmux, record.window.id)) {
          return focusTmuxWindow(this.deps.tmux, record.window.id);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      record.window.state = "closed";
    }
    return this.reopenWindow(id);
  }

  /** Reopen a closed agent session in a fresh window at max+1. */
  private async reopenWindow(id: string): Promise<boolean> {
    const record = this.agents.get(id);
    const spec = record?.launchSpec;
    if (!record || !spec || !record.mailboxDir) return false;
    const sessionFile = record.childSession?.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) return false;

    const exec = this.deps.tmux;
    const sessionResult = await exec(["display-message", "-p", "#{session_id}"]);
    if (sessionResult.code !== 0) return false;
    const tmuxSession = sessionResult.stdout.trim();

    const cwd = spec.runtime.cwd;

    const reopenSpec: AgentLaunchSpec = {
      ...spec,
      session: {
        ...spec.session,
        openFile: sessionFile,
        name: record.childSession?.sessionName ?? spec.session.name,
      },
      run: { ...spec.run, prompt: "" }, // reopen attaches, never re-sends the task
    };

    const specPath = join(record.mailboxDir, "reopen.json");
    writeLaunchSpec(specPath, reopenSpec);

    const command = this.deps.childCommand(specPath);
    const created = await createAgentWindow(exec, tmuxSession, {
      name: agentWindowName(record.id, spec.agent.type),
      cwd,
      command,
    });

    record.window = { id: created.id, index: created.index, name: created.name, state: "starting" };
    record.updatedAt = Date.now();
    this.emit({ type: "updated", record });
    return true;
  }

  /** Remove a record (fleet cleanup). The Pi session file is preserved. */
  private removeRecord(id: string, record: AgentRecord): void {
    this.stopWatchers(id);
    this.agents.delete(id);
    try { if (record.mailboxDir) removeMailboxDir(record.mailboxDir); } catch { /* ignore */ }
    this.emit({ type: "removed", id });
  }

  private stopWatchers(id: string): void {
    const watcher = this.watchers.get(id);
    if (watcher) { watcher.dispose(); this.watchers.delete(id); }
    const timer = this.windowTimers.get(id);
    if (timer) { clearInterval(timer); this.windowTimers.delete(id); }
    const rt = this.readyTimers.get(id);
    if (rt) { clearTimeout(rt); this.readyTimers.delete(id); }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Pass skipUnconsumed=true to preserve records the LLM has not read yet.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      (r) => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately (session shutdown). */
  abortAll(): number {
    let count = 0;
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.queue = [];
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.status = "stopped";
        record.completedAt = Date.now();
        if (record.mailboxDir) writeParentCommand(record.mailboxDir, { type: "abort" });
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to settle. */
  async waitForAll(): Promise<void> {
    while (this.hasRunning()) {
      await this.drainQueue();
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    for (const [id, record] of [...this.agents]) {
      // Ask live children to shut down, then stop tracking.
      if (record.window?.state !== "closed" && record.mailboxDir) {
        writeParentCommand(record.mailboxDir, { type: "shutdown" });
      }
      this.stopWatchers(id);
    }
    this.agents.clear();
    this.listeners.clear();
    this.settled.clear();
    this.readyTimers.clear();
  }
}
