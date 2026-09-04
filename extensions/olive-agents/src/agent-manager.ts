/**
 * agent-manager.ts — Coordinates child agent Pi sessions running in tmux
 * windows. The parent no longer owns an in-process AgentSession; instead each
 * child runs a native Pi TUI over a persistent session, and the manager:
 *
 *   - prepares launch specs and creates tmux windows (concurrency-queued)
 *   - watches each child's mailbox for lifecycle/tool events
 *   - forwards follow-up and explicit abort commands to the child
 *   - tracks per-record status, activity, usage and window state
 *
 * Foreground spawns bypass the concurrency queue and await run_settled.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { type AgentLaunchSpec, buildReopenDescriptor, prepareAgentLaunch, validateMaxTurns, writeLaunchSpec } from "./agent-runner.js";
import { contextReturnToMarkdown, type ContextLedgerNode, type ContextLinkData, type ContextReturnCheckpoint } from "./context-ledger.js";
import { type ChildEvent, ensureMailboxDir, readPendingDecision, removeMailboxDir, watchChildEvents, writeJsonAtomic, writeParentCommand } from "./event-mailbox.js";
import { createAgentWindow, execFromPi, findWindowByName as findTmuxWindowByName, focusWindow as focusTmuxWindow, killWindow as killTmuxWindow, shellQuote, windowAlive as tmuxWindowAlive, type TmuxExec } from "./tmux-window.js";
import { agentSessionName, agentWindowName } from "./names.js";
import { type AgentRecord, type AgentWindowInfo, type SubagentType, type ThinkingLevel } from "./types.js";
import { cloneSkillSnapshot, type SkillSnapshot } from "./skill-snapshot.js";

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
  promptPolicy?: "native" | "inherit";
  isBackground?: boolean;
  invocation?: AgentRecord["invocation"];
  /** Optional context ledger node accompanying this launch (persisted by the child). */
  ledgerNode?: ContextLedgerNode;
  /** Attached-context markdown injected into the child as a custom message. */
  contextMessage?: string;
  /** Launch-time snapshot of the parent's resolved Pi skills. */
  skillsSnapshot?: SkillSnapshot[];
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
export type OnContextCheckpoint = (record: AgentRecord, checkpoint: ContextReturnCheckpoint) => void;

/** Injectable side-effect surface (tests provide mocks). */
export interface ManagerDeps {
  tmux: TmuxExec;
  /** Prepare the launch spec. Defaults to the real implementation. */
  prepare: (input: Parameters<typeof prepareAgentLaunch>[0]) => Promise<{ spec: AgentLaunchSpec; warnings: string[] }>;
  /** Build the child command line for a launch spec path. */
  childCommand: (specPath: string) => string;
}

const DEFAULT_MAX_CONCURRENT = 5;
/** Give a starting child this long to report ready before declaring launch failure. */
const STARTUP_WATCHDOG_MS = 30_000;
/** Window liveness poll interval while a record has a window. */
const WINDOW_POLL_MS = 15_000;

function isDecisionPending(record: AgentRecord): boolean { return record.status === "awaiting_decision"; }
function isActiveRecord(record: AgentRecord): boolean {
  return record.status === "queued" || record.status === "running" || record.status === "idle" || isDecisionPending(record);
}
function isWorkActive(record: AgentRecord): boolean {
  return record.status === "queued" || record.status === "running" || isDecisionPending(record);
}
function isTerminalRecord(record: AgentRecord): boolean { return !isActiveRecord(record); }

function snapshotFromContext(ctx: unknown): SkillSnapshot[] | undefined {
  const getter = (ctx as { getSystemPromptOptions?: () => { skills?: unknown } } | undefined)?.getSystemPromptOptions;
  if (typeof getter !== "function") return undefined;
  try { return cloneSkillSnapshot(getter.call(ctx)?.skills); } catch { return undefined; }
}

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

/**
 * Resolve the executable used to boot child-host.mjs.
 *
 * Pi is distributed both as a Node program and as a standalone executable.
 * `process.execPath` points at Node in the former case, but points at Pi in
 * the latter; invoking the latter with a .mjs path makes Pi treat the paths as
 * startup messages instead of running the child host.
 */
export function resolveNodeExecutable(execPath: string = process.execPath): string {
  const executable = execPath.split(/[\\/]/).pop() ?? execPath;
  return /^(?:node|nodejs)(?:\.exe)?$/i.test(executable) ? execPath : "node";
}

/** Default child command line: `node <child-host.mjs> <specPath>`. */
export function defaultChildCommand(specPath: string, execPath: string = process.execPath): string {
  const hostPath = new URL("./child-host.mjs", import.meta.url).pathname;
  return `${shellQuote(resolveNodeExecutable(execPath))} ${shellQuote(hostPath)} ${shellQuote(specPath)}`;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private listeners = new Set<(event: AgentManagerEvent) => void>();
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onReady?: OnAgentReady;
  private onHumanSteer?: OnHumanSteer;
  private onContextCheckpoint?: OnContextCheckpoint;
  private onLink?: (link: ContextLinkData) => void;
  private maxConcurrent: number;
  private queue: { id: string; args: { pi: ExtensionAPI; ctx: ExtensionContext; type: SubagentType; prompt: string; options: SpawnOptions } }[] = [];
  private runningBackground = 0;
  private deps: ManagerDeps;
  private watchers = new Map<string, ReturnType<typeof watchChildEvents>>();
  private windowTimers = new Map<string, ReturnType<typeof setInterval>>();
  private settled = new Map<string, { promise: Promise<AgentRecord>; resolve: (r: AgentRecord) => void }>();
  private readyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

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
  setCallbacks(cb: { onReady?: OnAgentReady; onHumanSteer?: OnHumanSteer; onContextCheckpoint?: OnContextCheckpoint; onLink?: (link: ContextLinkData) => void }): void {
    if (cb.onReady) this.onReady = cb.onReady;
    if (cb.onHumanSteer) this.onHumanSteer = cb.onHumanSteer;
    if (cb.onContextCheckpoint) this.onContextCheckpoint = cb.onContextCheckpoint;
    if (cb.onLink) this.onLink = cb.onLink;
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
    if (!record || isActiveRecord(record)) return false;
    record.reviewedAt = Date.now();
    record.updatedAt = record.reviewedAt;
    this.emit({ type: "reviewed", record });
    return true;
  }

  removeTerminal(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || isActiveRecord(record)) return false;
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
    if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
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
      maxTurns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
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
    if (options.maxTurns !== undefined) validateMaxTurns(options.maxTurns);
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
    // Command callers can expose Pi's current base prompt options; this also
    // covers RPC/manual launches that did not explicitly carry a snapshot.
    const skillsSnapshot = options.skillsSnapshot === undefined
      ? snapshotFromContext(ctx)
      : cloneSkillSnapshot(options.skillsSnapshot);
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
      promptPolicy: options.promptPolicy,
      agentId: id,
      childSessionId,
      parentSessionFile,
      sessionDir,
      mailboxDir,
      ledgerNode: options.ledgerNode,
      ...(options.contextMessage ? { contextMessage: options.contextMessage } : {}),
      ...(skillsSnapshot === undefined ? {} : { skillsSnapshot }),
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

    // Persist the parent-session link BEFORE the window exists, so a crash
    // before the child reports ready leaves a discoverable launch record.
    if (this.onLink) {
      try {
        this.onLink({
          version: 1,
          stage: "launching",
          agentId: id,
          agentType: spec.agent.type,
          description: options.description,
          childSessionId,
          childSessionName: spec.session.name,
          ledgerNodeId: spec.ledger?.node.id,
          parentLedgerId: spec.ledger?.node.parentId,
          createdAt: new Date().toISOString(),
          mailboxDir,
          isBackground: options.isBackground,
          reopen: buildReopenDescriptor(spec),
        });
      } catch {
        /* link persistence must not break launch */
      }
    }

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
    if (options.isBackground) {
      this.runningBackground++;
      record.slotActive = true;
    }
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

    // Window liveness poll (observes kill-window / manual closes). Never
    // closes a window itself — windows persist until the human dismisses them
    // (via the toolbar or by exiting the child Pi session).
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
        // Reopened/restored children boot idle (or awaiting a restored
        // decision); fresh spawns with a task start running.
        if (record.launchSpec && record.launchSpec.run.prompt === "") {
          record.status = "idle";
          try {
            const bridgeState = JSON.parse(readFileSync(join(record.mailboxDir!, "bridge-state.json"), "utf-8")) as { status?: string };
            if (bridgeState.status === "awaiting_decision") record.status = "awaiting_decision";
            else if (bridgeState.status === "running") record.status = "running";
          } catch { /* keep idle */ }
        } else {
          record.status = "running";
        }
        record.updatedAt = Date.now();
        // Persist the resolved link now that the child session file is known.
        const linkSpec = record.launchSpec;
        if (linkSpec && this.onLink) {
          try {
            this.onLink({
              version: 1,
              stage: "ready",
              agentId: id,
              agentType: linkSpec.agent.type,
              description: linkSpec.agent.description,
              childSessionId: record.childSession?.sessionId ?? linkSpec.session.id,
              childSessionName: record.childSession?.sessionName ?? linkSpec.session.name,
              childSessionFile: event.sessionFile ?? record.childSession?.sessionFile,
              ledgerNodeId: linkSpec.ledger?.node.id,
              parentLedgerId: linkSpec.ledger?.node.parentId,
              createdAt: new Date().toISOString(),
              mailboxDir: record.mailboxDir,
              isBackground: record.isBackground,
              reopen: buildReopenDescriptor(linkSpec),
            });
          } catch {
            /* link persistence must not break ready handling */
          }
        }
        this.emit({ type: "updated", record });
        if (record.childSession) this.onReady?.(record, record.childSession);
        const rt = this.readyTimers.get(id);
        if (rt) { clearTimeout(rt); this.readyTimers.delete(id); }
        break;
      }

      case "run_started": {
        if (event.runNumber <= record.runNumber) break;
        record.status = "running";
        record.runNumber = event.runNumber;
        if (typeof event.maxTurns === "number") record.maxTurns = event.maxTurns;
        record.decision = undefined;
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
        if (event.runNumber != null && event.runNumber !== record.runNumber) break;
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
        if (event.runNumber != null && event.runNumber !== record.runNumber) break;
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
        if (event.runNumber != null && event.runNumber !== record.runNumber) break;
        record.turnCount = event.turnCount;
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        options.onTurnEnd?.(event.turnCount);
        break;
      }

      case "human_steer": {
        if (event.runNumber != null && event.runNumber !== record.runNumber) break;
        record.feedback = { kind: "steer", text: event.text, state: "delivered", updatedAt: Date.now() };
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        this.onHumanSteer?.(record, event.text);
        break;
      }

      case "run_idle": {
        if (event.runNumber < record.runNumber) break;
        record.runNumber = event.runNumber;
        record.status = "idle";
        record.turnCount = event.turnCount;
        record.toolUses = Math.max(record.toolUses, event.toolUses);
        record.maxTurns = event.maxTurns;
        record.decision = undefined;
        record.completedAt = undefined;
        record.updatedAt = Date.now();
        if (record.slotActive) {
          this.runningBackground = Math.max(0, this.runningBackground - 1);
          record.slotActive = false;
          void this.drainQueue();
        }
        this.emit({ type: "updated", record });
        break;
      }

      case "context_checkpoint": {
        const checkpoint = event.checkpoint;
        const seen = new Set(record.checkpointIds ?? []);
        if (seen.has(checkpoint.id)) {
          this.onContextCheckpoint?.(record, checkpoint);
          break;
        }
        seen.add(checkpoint.id);
        record.checkpointIds = [...seen];
        record.latestCheckpoint = checkpoint;
        record.result = contextReturnToMarkdown(checkpoint);
        record.status = "idle";
        record.completedAt = undefined;
        record.decision = undefined;
        record.updatedAt = Date.now();
        if (record.slotActive) {
          this.runningBackground = Math.max(0, this.runningBackground - 1);
          record.slotActive = false;
          void this.drainQueue();
        }
        this.onContextCheckpoint?.(record, checkpoint);
        this.emit({ type: "updated", record });
        break;
      }

      case "decision_required": {
        if (event.maxTurns !== undefined && (!Number.isInteger(event.maxTurns) || event.maxTurns < 1)) break;
        if (event.runNumber < record.runNumber || (event.runNumber === record.runNumber && record.status !== "running")) break;
        record.runNumber = event.runNumber;
        record.status = "awaiting_decision";
        record.decision = {
          reason: event.reason,
          requestedAt: event.requestedAt,
          result: event.result,
          turnCount: event.turnCount,
          toolUses: event.toolUses,
          maxTurns: event.maxTurns,
        };
        record.result = undefined;
        record.error = undefined;
        record.completedAt = undefined;
        record.reviewedAt = undefined;
        record.turnCount = event.turnCount;
        record.toolUses = event.toolUses;
        record.maxTurns = event.maxTurns;
        if (event.compactions != null) record.compactionCount = event.compactions;
        if (event.usage) record.lifetimeUsage = { ...event.usage };
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        break;
      }

      case "run_settled": {
        if (event.runNumber < record.runNumber || (event.runNumber === record.runNumber && record.status !== "awaiting_decision" && record.completedAt)) break;
        this.applySettled(record, event);
        break;
      }

      case "process_exit": {
        if (record.window) record.window.state = "closed";
        // Process exit is not a result release. Keep active/decision state so
        // the human can reopen the retained session; only run_settled may
        // resolve a foreground waiter or notify a background parent.
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
    record.decision = undefined;
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
      if (record.slotActive) {
        this.runningBackground = Math.max(0, this.runningBackground - 1);
        record.slotActive = false;
      }
      try { this.onComplete?.(record); } catch { /* ignore */ }
      void this.drainQueue();
    }
    this.emit({ type: "completed", record });
    // The tmux window stays open for human dismissal — result settlement has
    // no tmux side effect.
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
    if (!isTerminalRecord(record) || !record.resultConsumed) return;
    if (record.window && record.window.state !== "closed") return;
    this.removeRecord(record.id, record);
  }

  /**
   * Dismiss a terminal record: close its window (if still open) and forget it.
   * The Pi session file is preserved. Windows are independent — only this
   * record's window is touched. The record (and mailbox) is removed only when
   * the window is confirmed gone, so a failed kill leaves the toolbar row for
   * retry. Returns "dismissed" on success, "missing" when the window was
   * already gone, "active" for unknown/running/queued records, "failed" when
   * tmux refused the kill and the window still exists.
   */
  async dismiss(id: string): Promise<"dismissed" | "missing" | "active" | "failed"> {
    const record = this.agents.get(id);
    if (!record) return "active";
    // Only in-flight work (or a run parked at the decision gate) is
    // protected from dismissal. Idle children are settled and durable —
    // closing their tmux window keeps the session file for /ot reopen.
    if (isWorkActive(record)) return "active";

    if (record.window && record.window.state !== "closed") {
      if (!(await tmuxWindowAlive(this.deps.tmux, record.window.id))) {
        record.window.state = "closed";
        record.updatedAt = Date.now();
        this.emit({ type: "updated", record });
        this.removeRecord(id, record);
        return "missing";
      }
      const killed = await killTmuxWindow(this.deps.tmux, record.window.id);
      if (!killed) {
        // Confirm the window really is still alive before reporting failure.
        if (await tmuxWindowAlive(this.deps.tmux, record.window.id)) {
          return "failed";
        }
      }
      record.window.state = "closed";
      record.updatedAt = Date.now();
      this.emit({ type: "updated", record });

      // Wait for tmux to actually reap the window (kill-window is async-ish in
      // practice); a quick liveness re-probe keeps the record until it's gone.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await tmuxWindowAlive(this.deps.tmux, record.window.id))) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    this.removeRecord(id, record);
    return "dismissed";
  }

  /**
   * Human-initiated hard clear (/ocl). Works on ANY record state — the human
   * decides what is a zombie. Kills the tmux window (if alive), purges events
   * the dying child may still have written, writes `released-decision.json`
   * into the kept mailbox (so restoreFromPersisted skips it next session),
   * releases the concurrency slot, and drops the record. The Pi session file
   * and /ot context links are preserved. Returns "cleared" on success,
   * "missing" for an unknown id, "failed" when the window refused to die.
   */
  async forceClear(id: string): Promise<"cleared" | "missing" | "failed"> {
    const record = this.agents.get(id);
    if (!record) return "missing";
    this.stopWatchers(id);
    // A queued launch has no window and no mailbox — just drop it.
    this.queue = this.queue.filter((q) => q.id !== id);
    // Kill a live child window first so it cannot keep writing events.
    if (record.window && record.window.state !== "closed") {
      const alive = await tmuxWindowAlive(this.deps.tmux, record.window.id);
      if (alive && !(await killTmuxWindow(this.deps.tmux, record.window.id))) {
        if (await tmuxWindowAlive(this.deps.tmux, record.window.id)) return "failed";
      }
      record.window.state = "closed";
      // Let tmux actually reap the window before touching the mailbox so the
      // child's final process_exit cannot race our released marker.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await tmuxWindowAlive(this.deps.tmux, record.window.id))) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (record.mailboxDir) {
      try {
        const eventsDir = join(record.mailboxDir, "events");
        for (const name of readdirSync(eventsDir)) rmSync(join(eventsDir, name), { force: true });
      } catch { /* events dir already gone */ }
      try {
        writeJsonAtomic(join(record.mailboxDir, "released-decision.json"), {
          version: 1,
          releasedAt: new Date().toISOString(),
          reason: "cleared by /ocl",
        });
      } catch { /* mailbox unreachable; restore will skip via missing dir */ }
    }
    if (record.slotActive) {
      this.runningBackground = Math.max(0, this.runningBackground - 1);
      record.slotActive = false;
    }
    this.removeRecord(id, record, { keepMailbox: true });
    void this.drainQueue();
    return "cleared";
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
        if (!record) continue;
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
    options: { model?: Model<any>; thinking?: ThinkingLevel; maxTurns?: number; resultConsumed?: boolean; wait?: boolean } = {},
  ): Promise<AgentRecord | undefined> {
    validateMaxTurns(options.maxTurns);
    const record = this.agents.get(id);
    if (!record || record.status === "running" || record.status === "queued" || record.status === "awaiting_decision") return undefined;
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
    record.maxTurns = options.maxTurns;
    record.status = "running";
    record.decision = undefined;
    record.result = undefined;
    record.error = undefined;
    record.completedAt = undefined;
    record.resultConsumed = options.resultConsumed ?? false;
    record.feedback = { kind: "follow-up", text: prompt, state: "queued", updatedAt: Date.now() };
    record.updatedAt = Date.now();
    this.emit({ type: "updated", record });

    writeParentCommand(record.mailboxDir, { type: "follow_up", message: prompt, maxTurns: options.maxTurns });
    if (options.wait === false) return record;
    await wait;
    return this.agents.get(id);
  }

  /** Acknowledge a durable context checkpoint after the parent persisted it. */
  acknowledgeCheckpoint(id: string, checkpointId: string): boolean {
    const record = this.agents.get(id);
    if (!record?.mailboxDir) return false;
    writeParentCommand(record.mailboxDir, { type: "ack_checkpoint", checkpointId });
    return true;
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

    if (record.status === "awaiting_decision") {
      // The run is already stopped at a human gate. Preserve its held result;
      // Escape or parent cancellation must not turn it into a parent response.
      return true;
    }
    if (record.status !== "running") return false;
    // Request a child-side abort, but do not settle locally. The child records
    // an aborted pending decision, and only a later /or emits run_settled.
    record.stopReason = "stop requested";
    record.updatedAt = Date.now();
    this.emit({ type: "updated", record });
    if (record.mailboxDir) writeParentCommand(record.mailboxDir, { type: "abort" });
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

  /** Reattach a live/pending child after the parent Pi session was resumed. */
  async restoreFromPersisted(link: ContextLinkData): Promise<boolean> {
    const reopen = link.reopen;
    const mailboxDir = link.mailboxDir;
    if (!reopen || !mailboxDir || !existsSync(mailboxDir) || this.agents.has(link.agentId)) return false;
    // A released marker means the child already returned while this parent was
    // absent; its event remains in the mailbox and must be consumed once so the
    // resumed parent receives the normal completion notification.
    const pending = readPendingDecision(mailboxDir);
    const released = existsSync(join(mailboxDir, "released-decision.json"));
    let bridgeState: { status?: string; mode?: string; maxTurns?: number } | undefined;
    try { bridgeState = JSON.parse(readFileSync(join(mailboxDir, "bridge-state.json"), "utf-8")); } catch {}
    let hasQueuedEvents = false;
    try { hasQueuedEvents = readdirSync(join(mailboxDir, "events")).some((name) => name.endsWith(".json")); } catch {}
    // If an earlier parent already consumed the release, do not resurrect the
    // completed child merely because its tmux review window is still open.
    if (released && !hasQueuedEvents) return false;
    const windowName = agentWindowName(link.agentId, link.agentType);
    const live = await findTmuxWindowByName(this.deps.tmux, windowName);
    if (!pending && !released && !live && !bridgeState) return false;

    const spec: AgentLaunchSpec = {
      version: 3,
      agent: { id: link.agentId, type: link.agentType, displayName: link.agentType, description: link.description },
      session: { id: link.childSessionId, name: link.childSessionName, sessionDir: reopen.sessionDir, openFile: link.childSessionFile },
      runtime: {
        cwd: reopen.cwd, packageDir: getPackageDir(), model: reopen.model,
        thinking: reopen.thinking, tools: reopen.tools, noExtensions: reopen.noExtensions,
        extensionPaths: reopen.extensionPaths, noSkills: reopen.noSkills,
        ...(reopen.skillsSnapshotAuthoritative
          ? { skillsSnapshot: reopen.skillsSnapshot ?? [], skillsSnapshotAuthoritative: true }
          : {}),
        ...(reopen.systemPrompt === undefined ? {} : { systemPrompt: reopen.systemPrompt }),
        ...(reopen.promptPolicy ? { promptPolicy: reopen.promptPolicy } : {}),
      },
      run: { prompt: "", ...((pending?.maxTurns ?? reopen.maxTurns) !== undefined ? { maxTurns: pending?.maxTurns ?? reopen.maxTurns } : {}) },
      bridge: { mailboxDir },
    };
    const startedAt = Date.parse(link.createdAt) || Date.now();
    const restoredIdle = bridgeState?.status === "idle" || (pending != null && bridgeState?.mode === "interactive");
    const record: AgentRecord = {
      id: link.agentId, type: link.agentType, description: link.description,
      status: restoredIdle ? "idle" : pending ? "awaiting_decision" : "running", decision: pending ? { ...pending } : undefined,
      toolUses: pending?.toolUses ?? 0, startedAt, lifetimeUsage: pending?.usage ? { ...pending.usage } : { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: pending?.compactions ?? 0, originalPrompt: "", effectivePrompt: "", updatedAt: Date.now(),
      runNumber: pending?.runNumber ?? 0, turnCount: pending?.turnCount ?? 0, maxTurns: pending?.maxTurns ?? reopen.maxTurns,
      // The original foreground tool call cannot survive a closed parent
      // process. Treat restored records as notification-backed until release.
      isBackground: true, childSession: { sessionId: link.childSessionId, sessionName: link.childSessionName, sessionFile: link.childSessionFile },
      mailboxDir, launchSpec: spec,
      ...(live ? { window: { id: live.id, index: live.index, name: live.name, state: "alive" as const } } : {}),
    };
    this.agents.set(record.id, record);
    if (!restoredIdle) {
      this.runningBackground++;
      record.slotActive = true;
    }
    this.emit({ type: "created", record });
    const watcher = watchChildEvents(mailboxDir, (events) => {
      for (const event of events) this.handleChildEvent(record.id, event, { description: record.description });
    });
    this.watchers.set(record.id, watcher);
    return true;
  }

  /**
   * Reopen a persisted agent session from its link metadata (used by /ot when
   * no manager record exists, e.g. after the parent was resumed). Finds an
   * already-live window by stable name and focuses it (no duplicate); otherwise
   * opens the session JSONL in a fresh window WITHOUT resubmitting the task.
   * Returns { ok, focused, windowId?, windowName? }.
   */
  async reopenFromPersisted(link: ContextLinkData): Promise<{ ok: boolean; focused: boolean; windowId?: string; windowName?: string }> {
    const sessionFile = link.childSessionFile;
    const reopen = link.reopen;
    if (!sessionFile || !existsSync(sessionFile) || !reopen) {
      return { ok: false, focused: false };
    }

    const exec = this.deps.tmux;
    const windowName = agentWindowName(link.agentId, link.agentType);

    // Fresh mailbox: launch specs and mailbox dirs are one-shot, never reused.
    const mailboxDir = join(tmpdir(), "olive-agents", link.agentId, "reopen");
    ensureMailboxDir(mailboxDir);

    const spec: AgentLaunchSpec = {
      version: 3,
      agent: {
        id: link.agentId,
        type: link.agentType,
        displayName: link.agentType,
        description: link.description,
      },
      session: {
        id: link.childSessionId,
        name: link.childSessionName,
        sessionDir: reopen.sessionDir,
        openFile: sessionFile,
      },
      runtime: {
        cwd: reopen.cwd,
        packageDir: getPackageDir(),
        model: reopen.model,
        thinking: reopen.thinking,
        tools: reopen.tools,
        noExtensions: reopen.noExtensions,
        extensionPaths: reopen.extensionPaths,
        noSkills: reopen.noSkills,
        ...(reopen.skillsSnapshotAuthoritative
          ? { skillsSnapshot: reopen.skillsSnapshot ?? [], skillsSnapshotAuthoritative: true }
          : {}),
        ...(reopen.systemPrompt === undefined ? {} : { systemPrompt: reopen.systemPrompt }),
        ...(reopen.promptPolicy ? { promptPolicy: reopen.promptPolicy } : {}),
      },
      run: { prompt: "", ...(reopen.maxTurns !== undefined ? { maxTurns: reopen.maxTurns } : {}) }, // reopen attaches; never re-sends the task
      bridge: { mailboxDir },
    };

    const existing = await findTmuxWindowByName(exec, windowName);
    if (existing) {
      await focusTmuxWindow(exec, existing.id);
      this.registerReopenedRecord(link, spec, mailboxDir, {
        id: existing.id, index: existing.index, name: existing.name, state: "alive" as const,
      });
      return { ok: true, focused: true, windowId: existing.id, windowName };
    }

    const sessionResult = await exec(["display-message", "-p", "#{session_id}"]);
    if (sessionResult.code !== 0) return { ok: false, focused: false };
    const tmuxSession = sessionResult.stdout.trim();

    const specPath = join(mailboxDir, "reopen.json");
    writeLaunchSpec(specPath, spec);
    const command = this.deps.childCommand(specPath);

    try {
      const created = await createAgentWindow(exec, tmuxSession, {
        name: windowName,
        cwd: reopen.cwd,
        command,
      });
      this.registerReopenedRecord(link, spec, mailboxDir, {
        id: created.id, index: created.index, name: created.name, state: "starting" as const,
      });
      return { ok: true, focused: false, windowId: created.id, windowName };
    } catch (err) {
      console.error("[olive-agents] reopen of agent session failed:", err instanceof Error ? err.message : err);
      return { ok: false, focused: false };
    }
  }

  /**
   * Register a managed record + mailbox watcher for an /ot-reopened session so
   * its events (context checkpoints, run_idle, ready) flow back to the parent.
   * Reopened children never occupy a background execution slot.
   */
  private registerReopenedRecord(link: ContextLinkData, spec: AgentLaunchSpec, mailboxDir: string, window?: AgentWindowInfo): void {
    if (this.agents.has(link.agentId)) return;
    const record: AgentRecord = {
      id: link.agentId,
      type: link.agentType,
      description: link.description,
      status: "running", // corrected by the child's boot bridge-state at ready
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      originalPrompt: "",
      effectivePrompt: "",
      updatedAt: Date.now(),
      runNumber: 0,
      turnCount: 0,
      maxTurns: spec.run.maxTurns,
      isBackground: true,
      childSession: {
        sessionId: link.childSessionId,
        sessionName: link.childSessionName,
        sessionFile: link.childSessionFile,
      },
      mailboxDir,
      launchSpec: spec,
      slotActive: false,
      ...(window ? { window } : {}),
    };
    this.agents.set(record.id, record);
    this.emit({ type: "created", record });
    const watcher = watchChildEvents(mailboxDir, (events) => {
      for (const event of events) this.handleChildEvent(record.id, event, { description: record.description });
    });
    this.watchers.set(record.id, watcher);
    // Window liveness poll so manual closes update the record.
    const poll = setInterval(() => {
      const rec = this.agents.get(record.id);
      if (!rec?.window || rec.window.state === "closed") return;
      void tmuxWindowAlive(this.deps.tmux, rec.window.id).then((alive) => {
        const r = this.agents.get(record.id);
        if (!r?.window || r.window.state === "closed") return;
        if (!alive) {
          r.window.state = "closed";
          r.updatedAt = Date.now();
          this.emit({ type: "updated", record: r });
        }
      });
    }, WINDOW_POLL_MS);
    poll.unref?.();
    this.windowTimers.set(record.id, poll);
  }

  /**
   * Remove a record (fleet cleanup). The Pi session file is preserved.
   * keepMailbox=true preserves the mailbox (with a released marker) so /ot
   * metadata and the child session stay intact and restores skip it.
   */
  private removeRecord(id: string, record: AgentRecord, opts: { keepMailbox?: boolean } = {}): void {
    this.stopWatchers(id);
    this.agents.delete(id);
    if (!opts.keepMailbox) {
      try { if (record.mailboxDir) removeMailboxDir(record.mailboxDir); } catch { /* ignore */ }
    }
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
      if (isActiveRecord(record)) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      (r) => isWorkActive(r),
    );
  }

  /** Abort all active agents immediately (explicit parent stop). */
  abortAll(): number {
    const ids = [...this.agents.values()].filter(isActiveRecord).map((record) => record.id);
    let count = 0;
    for (const id of ids) if (this.abort(id)) count++;
    return count;
  }

  /** Wait for all running and queued agents to settle. */
  async waitForAll(): Promise<void> {
    while (this.hasRunning()) {
      await this.drainQueue();
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Detach this manager from its children. A parent Pi shutdown must not stop
   * child hosts: their tmux windows and mailbox command loops remain usable
   * after the parent window is gone.
   */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    for (const id of this.agents.keys()) {
      this.stopWatchers(id);
    }
    this.agents.clear();
    this.listeners.clear();
    this.settled.clear();
    this.readyTimers.clear();
  }
}
