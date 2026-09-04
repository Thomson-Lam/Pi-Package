/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AgentManager } from "./agent-manager.js";
import { getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, validateMaxTurns } from "./agent-runner.js";
import { approveInvocation, approveManualLaunch, availableThinkingLevels, buildLedgerContext, selectSubagentModel, type ApprovalContextInput, type BuiltLedgerContext } from "./approval.js";
import { getAgentConfig, getAllTypes, getAvailableTypes, isDefaultsDisabled, registerAgents, resolveType, setDefaultsDisabled } from "./agent-types.js";
import {
  CONTEXT_LINK_ENTRY,
  CONTEXT_RETURN_ENTRY,
  type ContextLedgerNode,
  type ContextLinkData,
  type ContextReturnCheckpoint,
  contextReturnToMarkdown,
  finalizeContextReturn,
  finalizeLedgerContext,
  getSessionLedgerNode,
  returnableContextEntries,
  getSessionLinks,
  loadLedgerGraph,
  plainEntries,
  readSessionEntries,
  resolveAncestorChain,
  resolveNearestLedgerAncestors,
  sessionDisplayName,
  summarizeSelections,
} from "./context-ledger.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { NudgeScheduler } from "./nudge.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type JoinMode, type NotificationDetails, type SubagentType, type ThinkingLevel } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatAgentSessionPickerHint,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  SPINNER,
  type Theme,
} from "./ui/format.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { execFromPi, findWindowByName, focusWindow } from "./tmux-window.js";
import { openContextTree } from "./ui/context-tree.js";
import { buildContextUI } from "./ui/context-selection.js";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.js";
import { cloneSkillSnapshot, type SkillSnapshot } from "./skill-snapshot.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails, terminate = false) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any, ...(terminate ? { terminate: true } : {}) };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ---- Context-ledger workflow helpers -------------------------------------

/**
 * Build the approval context input for the current session: selectable branch
 * entries, nearest-first ancestor ledger nodes, and a summarizer bound to the
 * CURRENT model so a model change in approval regenerates with the new model.
 */
function makeApprovalContextInput(
  ctx: ExtensionCommandContext | ExtensionContext,
): ApprovalContextInput | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  let branch;
  try {
    branch = ctx.sessionManager.getBranch();
  } catch {
    return undefined;
  }
  if (!branch || branch.length === 0) return undefined;
  const candidates = sessionFile ? resolveNearestLedgerAncestors(sessionFile) : [];
  return {
    branch,
    candidates,
    summarize: (branchEntries, selectedIds, model, thinking, customInstructions) =>
      summarizeSelections(ctx.modelRegistry, {
        branch: branchEntries,
        selectedIds,
        model,
        thinking,
        customInstructions,
      }),
    ...(ctx.sessionManager.getSessionFile()
      ? {
          openInheritTree: async (initialId?: string): Promise<ContextLedgerNode[] | undefined> => {
            const file = ctx.sessionManager.getSessionFile()!;
            const graph = loadLedgerGraph(file, readSessionEntries, sessionDisplayName);
            const ancestorFiles = resolveAncestorChain(file).map((a) => a.sessionFile);
            const own = getSessionLedgerNode(plainEntries(readSessionEntries(file)));
            const result = await openContextTree({
              ctx,
              graph,
              ancestorFiles,
              currentFile: file,
              currentLedgerId: own?.id,
              mode: "select",
              initialSelectedId: initialId,
              focusOrOpen: async () => {},
            });
            if (!result?.startsWith("inherit:")) return undefined;
            const chain: ContextLedgerNode[] = [];
            const seen = new Set<string>();
            let node = graph.nodes.get(result.slice(8));
            while (node && !seen.has(node.id)) {
              seen.add(node.id);
              chain.unshift(node);
              node = node.parentId ? graph.nodes.get(node.parentId) : undefined;
            }
            return chain;
          },
        }
      : {}),
  };
}


/** A human-legible label for the current session (named sessions win; the root
 *  main session is unnamed, so fall back to its file basename without the ISO
 *  timestamp prefix). */
function sessionLabel(ctx: ExtensionCommandContext | ExtensionContext): string {
  const name = ctx.sessionManager.getSessionName();
  if (name) return name;
  const file = ctx.sessionManager.getSessionFile();
  if (file) {
    const base = basename(file).replace(/\.jsonl$/, "");
    const stripped = base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/, "");
    return stripped || base;
  }
  return "this session";
}

/**
 * Turn an approved context into a launch-ready ledger node + the final child
 * prompt. The prompt embeds the full inherited chain (ancestor nodes root→leaf
 * plus the new node). Returns the unmodified prompt when no context was built
 * (isolated launch — current behavior unchanged).
 */
function finalizeLaunchContext(
  ctx: ExtensionCommandContext | ExtensionContext,
  built: BuiltLedgerContext | undefined,
  instructions: string,
): { prompt: string; ledgerNode?: ContextLedgerNode } {
  if (!built) return { prompt: instructions };
  let branch;
  try {
    branch = ctx.sessionManager.getBranch();
  } catch {
    branch = [];
  }
  return finalizeLedgerContext({
    instructions,
    built,
    branch,
    sourceSessionFile: ctx.sessionManager.getSessionFile(),
    sourceSessionName: sessionLabel(ctx),
  });
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = null;
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.childSession?.sessionFile ? `<session-file>${escapeXml(record.childSession.sessionFile)}</session-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/**
 * Guidance for provider transport/model failures (e.g. "Not Found"), injected
 * into the Agent launch tool result so the main agent sees why prior children
 * failed and what to do about it.
 */
function providerErrorHint(error: string | undefined): string {
  if (!error || !/\bnot\s*found\b|404|provider transport|provider error/i.test(error)) return "";
  const firstLine = error.trim().split(/\r?\n/)[0] ?? error;
  return (
    `\n\n== Provider failure ==\n${firstLine}\n` +
    `Children inherit the parent's current model. Switch the parent's model (Ctrl+P) before relaunching, ` +
    `or relaunch this agent with an explicit working \"model\" parameter (e.g. opencode-go/gpt-5.6-luna). ` +
    `Stuck agents can be cleared with /ocl.`
  );
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; turnCount?: number; maxTurns?: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount ?? record.turnCount,
    maxTurns: activity?.maxTurns ?? record.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? record.turnCount,
    maxTurns: activity?.maxTurns ?? record.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    sessionFile: record.childSession?.sessionFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

export default function (pi: ExtensionAPI) {
  // Captured from Pi's resolved prompt inputs at parent launch time. This is
  // intentionally a snapshot: children do not follow later resource changes.
  let parentSkillsSnapshot: SkillSnapshot[] | undefined;

  const skillsForLaunch = (ctx: unknown): SkillSnapshot[] | undefined => {
    const getter = (ctx as { getSystemPromptOptions?: () => { skills?: unknown } } | undefined)?.getSystemPromptOptions;
    if (typeof getter === "function") {
      try {
        const snapshot = cloneSkillSnapshot(getter.call(ctx)?.skills);
        if (snapshot !== undefined) return snapshot;
      } catch { /* fall back to the latest lifecycle snapshot */ }
    }
    return cloneSkillSnapshot(parentSkillsSnapshot);
  };

  // Normal Agent-tool launches happen after this event. It exposes Pi's
  // already-resolved project, global, package, and runtime-discovered skills.
  pi.on("before_agent_start", (event) => {
    parentSkillsSnapshot = cloneSkillSnapshot(event.systemPromptOptions.skills);
  });

  // The plain child bootstrap requests this shared TypeScript flow over the
  // in-process event bus. This keeps /or and automatic Return on the exact
  // same selector/compaction implementation as launch approval.
  const unsubscribeReturnBuilder = pi.events.on("olive-agents:return-context-request", async (raw: unknown) => {
    const request = raw as {
      agentId?: string;
      reason?: ContextReturnCheckpoint["reason"];
      ctx?: ExtensionContext;
      respond?: (result: { checkpoint?: ContextReturnCheckpoint; cancelled?: boolean; error?: string }) => void;
    };
    if (!request.agentId || !request.ctx || !request.respond) return;
    const childCtx = request.ctx;
    try {
      const allEntries = childCtx.sessionManager.getBranch();
      const branch = returnableContextEntries(allEntries);
      if (!branch.some((entry) => entry.type === "message")) {
        childCtx.ui.notify("No new child context is available to return.", "info");
        request.respond({ cancelled: true });
        return;
      }
      if (!childCtx.model) throw new Error("No active child model is available for context compaction.");
      const built = await buildLedgerContext(
        childCtx,
        childCtx.modelRegistry,
        { model: childCtx.model, thinking: childCtx.thinkingLevel ?? "off" },
        {
          branch,
          candidates: [],
          summarize: (entries, selectedIds, model, thinking, customInstructions) =>
            summarizeSelections(childCtx.modelRegistry, { branch: entries, selectedIds, model, thinking, customInstructions }),
        },
        {
          allowInheritance: false,
          title: "Select context to return to parent",
          nextHint: "compact? → return",
          compactQuestion: "Compact all new child conversation before return?",
        },
      );
      if (!built) {
        request.respond({ cancelled: true });
        return;
      }
      // Optional check-in note, returned to the parent as a user message.
      // Empty input or cancel skips the note; the context still returns.
      const noteText = await childCtx.ui.input(
        "Message to return to the parent (empty to skip)",
      );
      const note = noteText?.trim() || undefined;
      const checkpoint = finalizeContextReturn({
        agentId: request.agentId,
        built,
        branch,
        sourceSessionFile: childCtx.sessionManager.getSessionFile(),
        sourceSessionName: sessionLabel(childCtx),
        reason: request.reason ?? "manual",
        ...(note ? { note } : {}),
      });
      pi.appendEntry(CONTEXT_RETURN_ENTRY, checkpoint);
      request.respond({ checkpoint });
    } catch (error) {
      request.respond({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: session file link (if present)
        if (d.sessionFile) {
          line += "\n  " + theme.fg("muted", `session: ${d.sessionFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    }
  );

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Cancellable pending notifications ----
  // Completion/group notifications are held until the parent agent is IDLE —
  // delivered immediately when idle, otherwise at the next agent_settled
  // boundary — so get_subagent_result called any time during a busy turn can
  // cancel them. The send-time resultConsumed re-check inside each nudge then
  // guarantees exactly-once delivery with no redundant feedback to the main
  // agent.
  const nudges = new NudgeScheduler();

  pi.on("agent_start", () => { nudges.setBusy(true); });
  pi.on("agent_settled", () => {
    nudges.setBusy(false);
    flushPendingNudges();
  });

  function scheduleNudge(key: string, send: () => void) {
    nudges.schedule(key, send);
    flushPendingNudges();
  }

  function cancelNudge(key: string) {
    nudges.cancel(key);
  }

  /** Deliver held nudges once the parent is idle (and no approval dialog is open). */
  function flushPendingNudges() {
    if (pendingApprovals > 0) return;
    nudges.flush();
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.childSession?.sessionFile ? `\nSession file: ${record.childSession.sessionFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    scheduleNudge(record.id, () => emitIndividualNudge(record));
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) return;

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300);
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
    },
    30_000,
  );

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  const receivedCheckpointIds = new Set<string>();
  /** True once the parent-session no-op /or has been registered. */
  let parentOrRegistered: boolean | undefined;

  // Serialize checkpoint deliveries: two returns must never race the parent's
  // run guard ("Agent is already processing a prompt"), and a user message is
  // never sent without a delivery mode (which throws while streaming).
  let checkpointDeliveryTail: Promise<void> = Promise.resolve();
  const waitUntilParentIdle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (currentCtx?.isIdle?.() !== false) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
        return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, { tmux: execFromPi(pi) });

  // Child lifecycle callbacks: session linkage persistence + steering notifications.
  manager.setCallbacks({
    onReady: (record, identity) => {
      pi.appendEntry("olive-agent-session", {
        agentId: record.id,
        type: record.type,
        description: record.description,
        childSessionId: identity.sessionId,
        childSessionFile: identity.sessionFile,
        parentSessionFile: identity.parentSessionFile,
        sessionName: identity.sessionName,
      });
    },
    onHumanSteer: (record, text) => {
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification",
        content: `Agent "${record.description}" was steered by the user.\n\nSteering message:\n${text}`,
        display: true,
        details: {
          id: record.id,
          description: record.description,
          status: "running",
          toolUses: record.toolUses,
          turnCount: record.turnCount,
          maxTurns: record.maxTurns,
          totalTokens: getLifetimeTotal(record.lifetimeUsage),
          durationMs: Date.now() - record.startedAt,
          sessionFile: record.childSession?.sessionFile,
          resultPreview: text.slice(0, 500),
          kind: "human-steer",
        },
      }, { deliverAs: "followUp", triggerTurn: true });
    },
    onContextCheckpoint: (record, checkpoint) => {
      if (receivedCheckpointIds.has(checkpoint.id)) {
        manager.acknowledgeCheckpoint(record.id, checkpoint.id);
        return;
      }
      const markdown = contextReturnToMarkdown(checkpoint);
      // Markdown-only format: `## context` + numbered `## agent (N)` sections.
      // No XML wrapper, no metadata bullets, no footer.
      const content = markdown;
      const sendCheckpoint = (body: string, trigger: boolean) =>
        pi.sendMessage({ customType: "subagent-context-checkpoint", content: body, display: true, details: { checkpointId: checkpoint.id, agentId: record.id, markdown } }, { deliverAs: "followUp", triggerTurn: trigger });
      if (checkpoint.note) {
        const note = checkpoint.note;
        // Serialize: wait out any in-flight parent run, append the checkpoint
        // context silently, then let the note be the single user message that
        // triggers the parent turn — the two land in the same context snapshot.
        checkpointDeliveryTail = checkpointDeliveryTail
          .then(async () => {
            await waitUntilParentIdle();
            sendCheckpoint(content, false);
            pi.sendUserMessage(note, { deliverAs: "steer" });
          })
          .catch(() => { /* delivery is best-effort; the ack below still runs */ });
      } else {
        // No note: the checkpoint itself notifies the parent after it is idle.
        checkpointDeliveryTail = checkpointDeliveryTail
          .then(async () => {
            await waitUntilParentIdle();
            sendCheckpoint(content, true);
          })
          .catch(() => { /* best-effort */ });
      }
      try {
        pi.appendEntry("olive-agent-context-return-received", {
          version: 1,
          checkpointId: checkpoint.id,
          agentId: record.id,
          receivedAt: new Date().toISOString(),
        });
        receivedCheckpointIds.add(checkpoint.id);
        manager.acknowledgeCheckpoint(record.id, checkpoint.id);
      } catch (error) {
        console.error("[olive-agents] failed to persist returned child context:", error instanceof Error ? error.message : error);
      }
    },
    // Persist the child-session link in the parent session so /ot can rebuild
    // the context tree after a resume, and /ot can reopen the child session.
    onLink: (link: ContextLinkData) => {
      try {
        pi.appendEntry(CONTEXT_LINK_ENTRY, link);
      } catch (err) {
        console.error("[olive-agents] failed to persist context link:", err instanceof Error ? err.message : err);
      }
    },
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;

  // Capture ctx from session_start for RPC spawn handlers and retained UI state.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    // A parent session must expose /or as a recognized no-op: otherwise an
    // unknown slash command falls through to the model. Children get the real
    // /or from the child bridge (which only registers when a parent exists).
    if (parentOrRegistered !== true) {
      try {
        const header = ctx.sessionManager.getEntries().find((e) => (e as { type?: string }).type === "session");
        const hasParent = Boolean((header as { parentSession?: string } | undefined)?.parentSession);
        if (!hasParent) {
          parentOrRegistered = true;
          pi.registerCommand("or", {
            description: "No-op: this session is not a child agent session",
            handler: async (_args, commandCtx) => {
              commandCtx.ui.notify?.("/or only returns context from a child agent session — nothing to do here.", "info");
            },
          });
        }
      } catch { /* best effort */ }
    }
    receivedCheckpointIds.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "olive-agent-context-return-received") {
        const checkpointId = (entry.data as { checkpointId?: unknown } | undefined)?.checkpointId;
        if (typeof checkpointId === "string") receivedCheckpointIds.add(checkpointId);
        continue;
      }
      if (entry.type === "message") {
        const message = entry.message as { role?: string; customType?: string; details?: { checkpointId?: unknown } };
        if (message.role === "custom" && message.customType === "subagent-context-checkpoint" && typeof message.details?.checkpointId === "string") {
          receivedCheckpointIds.add(message.details.checkpointId);
        }
      }
    }
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    // Reattach mailbox watchers before handling new work. Child windows outlive
    // the parent, so a pending decision or /or release may have happened while
    // this parent Pi window was closed.
    const latestLinks = new Map<string, ContextLinkData>();
    for (const link of getSessionLinks(ctx.sessionManager.getEntries())) {
      latestLinks.set(link.agentId, link); // later ready entries replace launching entries
    }
    for (const link of latestLinks.values()) {
      try { await manager.restoreFromPersisted(link); } catch { /* stale links are ignored */ }
    }
    // A double-bind must not leak RPC listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager,
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    // A child agent session owned by a live tmux window must not be opened in
    // this parent TUI — two Pi processes appending to the same JSONL would
    // corrupt/branch it. Cancel the switch and focus the owning window instead.
    const target = (event as { targetSessionFile?: string }).targetSessionFile;
    if (target) {
      const record = manager.recordBySessionFile(target);
      if (record && record.window && record.window.state !== "closed" && record.window.id) {
        try { await manager.focusOrReopen(record.id); } catch { /* ignore */ }
        ctx.ui.notify(
          `Session is a live agent window (${record.description}). Switch cancelled — focused its tmux window instead.`,
          "info",
        );
        return { cancel: true };
      }
      // /ot-reopened sessions: same corruption guard, keyed by window name.
      const windowName = reopenedWindows.get(target);
      if (windowName) {
        const live = await findWindowByName(execFromPi(pi), windowName);
        if (live) {
          await focusWindow(execFromPi(pi), live.id);
          ctx.ui.notify(
            "Session is open in an agent window. Switch cancelled — focused its tmux window instead.",
            "info",
          );
          return { cancel: true };
        }
        reopenedWindows.delete(target);
      }
    }
    manager.abortAll();
    manager.clearCompleted();
  });

  // On shutdown, detach local tracking without stopping child hosts. Each child
  // owns its tmux window and must survive the parent Pi window closing.
  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle = undefined;
    currentCtx = undefined;
    unsubscribeReturnBuilder();
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    nudges.clear();
    fleet.dispose();
    manager.dispose();
  });

  // Passive compact overview below the editor.
  const fleet = new FleetList(manager);

  // Agent sessions reopened from /ot (no manager record exists). Keyed by
  // session file → tmux window name, so the session_before_switch guard can
  // prevent opening a live agent JSONL in the parent TUI.
  const reopenedWindows = new Map<string, string>();

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
  function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

  // ---- Disable default agents configuration ----
  // When enabled, the hardcoded default agent (general-purpose) is not
  // registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or olive-agents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // Capture the current UI for the passive overview.
  pi.on("tool_execution_start", async (_event, ctx) => {
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
  });

  /** Agent tools are copied from the parent at launch time. */
  const formatToolsSuffix = (_cfg: AgentConfig | undefined): string => "parent";

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Tool calls from one assistant message may execute concurrently. Serialize
  // approval dialogs so each proposed subagent gets one unambiguous decision.
  let approvalTail: Promise<void> = Promise.resolve();
  let pendingApprovals = 0;
  async function withApproval<T>(show: () => Promise<T>): Promise<T> {
    pendingApprovals++;
    const previous = approvalTail;
    let release!: () => void;
    approvalTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await show();
    } finally {
      pendingApprovals--;
      release();
    }
  }

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parent behavior: run_in_background false/omitted detaches from the child and ends the parent loop; true lets the parent continue working. Either mode notifies the parent after the human returns the child result.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID.
- The child uses the parent working directory, tools, and extensions.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls.
- Every fresh delegated run requires max_turns, a positive work-turn limit. Without human input, natural completion and the turn ceiling open Continue, Return, or Feedback automatically. Human interruption/input switches the child to unlimited interactive mode; /or then opens that selector. Return uses the context builder and may be repeated later for new, unsent context.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Leave run_in_background false or omit it to detach from the child: the Agent tool returns immediately and terminates the current parent loop. The parent accepts the next user prompt while the child continues.
- Set run_in_background true only when the parent should continue its current loop after launch. Both modes notify the parent after the human returns the child result.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- The child uses the parent's working directory, active tools, and loaded extensions.

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

## Context

The child starts fresh and receives only the self-contained task prompt.

- The child uses the parent's working directory, active tools, and loaded extensions.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type. Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.Optional(Type.String({
        description: `Optional agent type. Omit to inherit the parent runtime; explicitly use general-purpose for Pi's native system prompt. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      })),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Integer({
        description: "Required positive work-turn ceiling. Every fresh run and every resume requires a new limit. Reconciliation reporting is separate and does not count as a work turn.",
        minimum: 1,
      }),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Set true to let the current parent loop continue after launch. False/omitted detaches from the child, returns immediately, and terminates the current parent loop. Both modes notify the parent when the child returns a context checkpoint.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
      }

      // ---- Agent launched without waiting ----
      if (details.status === "background" || details.status === "detached") {
        const label = details.status === "detached" ? "Detached from child" : "Running in background";
        return new Text(theme.fg("dim", `  ⎿  ${label} (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
      const launchSkillsSnapshot = skillsForLaunch(ctx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType | undefined;
      const resolved = rawType ? resolveType(rawType) : undefined;
      const subagentType = resolved ?? "general-purpose";
      const fellBack = rawType !== undefined && resolved === undefined;

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list (read in `enabled-models.ts`).
      //
      // Design: scopeModels guards against *runtime* LLM choices, not user-level config.
      //   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
      //     out-of-scope choice; surface it so it picks differently).
      //   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
      //     user authored/installed this agent or chose the parent's model; trust it).
      // See SubagentsSettings.scopeModels docstring for the full policy.
      if (isScopeModelsEnabled() && model) {
        const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
        if (allowed && !isModelInScope(model, allowed)) {
          if (resolvedConfig.modelFromParams) {
            const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
            return textResult(
              `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from enabledModels):\n${list}`,
            );
          }
          // Frontmatter-pinned or parent-inherited: warn + proceed.
          const agentLabel = customConfig?.displayName ?? subagentType;
          const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
          ctx.ui.notify(
            `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
            "warning",
          );
        }
      }

      if (!model) {
        return textResult("Subagent launch blocked: no effective model is available for review.");
      }
      const initialModel = model;

      let thinking = clampThinkingLevel(
        initialModel,
        resolvedConfig.thinking ?? pi.getThinkingLevel(),
      ) as ThinkingLevel;
      // Agent tool calls cannot inherit an unlimited/default budget: the
      // parent must provide a fresh positive integer on every run.
      try { validateMaxTurns(params.max_turns); } catch (err) { return textResult(err instanceof Error ? err.message : String(err)); }
      const requestedMaxTurns = params.max_turns as number;
      let runInBackground = resolvedConfig.runInBackground;

      // Resume existing agent. A resume is a new delegated task and therefore
      // receives its own approval, while retaining the subagent's prior session.
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleared or belong to a prior parent session.`);
        }
        if (!existing.childSession) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        const resumeModel = existing.launchSpec
          ? resolveModel(`${existing.launchSpec.runtime.model.provider}/${existing.launchSpec.runtime.model.id}`, ctx.modelRegistry)
          : undefined;
        if (typeof resumeModel === "string" || !resumeModel) {
          return textResult(`Agent "${params.resume}" has no effective model to review.`);
        }
        const resumeApproval = await withApproval(() => approveInvocation(ctx, ctx.modelRegistry, {
          agentType: existing.type,
          description: existing.description,
          prompt: params.prompt,
          model: resumeModel,
          thinking: existing.launchSpec?.runtime.thinking ?? pi.getThinkingLevel(),
          maxTurns: requestedMaxTurns,
          runInBackground,
        }));
        if (resumeApproval.outcome === "feedback") {
          return textResult(`feedback: ${resumeApproval.feedback}`);
        }
        if (resumeApproval.outcome === "do-it-yourself") {
          return textResult("do it yourself");
        }
        if (resumeApproval.outcome === "cancel") {
          return textResult(`Subagent resume cancelled. Agent "${params.resume}" was not started.`);
        }

        const resumeModelName = resumeApproval.model.id !== ctx.model?.id
          ? (resumeApproval.model.name ?? resumeApproval.model.id).replace(/^Claude\s+/i, "").toLowerCase()
          : undefined;
        const resumeInvocation: AgentInvocation = {
          ...existing.invocation,
          modelName: resumeModelName,
          thinking: resumeApproval.thinking,
          maxTurns: resumeApproval.maxTurns,
          runInBackground: resumeApproval.runInBackground,
        };
        const { tags: resumeTags } = buildInvocationTags(resumeInvocation);
        const resumeDetailBase = {
          displayName: getDisplayName(existing.type),
          description: existing.description,
          subagentType: existing.type,
          modelName: resumeModelName,
          tags: resumeTags.length > 0 ? resumeTags : undefined,
        };
        // Every resumed child is notification-backed. Parent behavior controls
        // only whether this parent loop continues after the launch.
        existing.isBackground = true;
        const record = await manager.resume(params.resume, resumeApproval.prompt, signal, {
          model: resumeApproval.model,
          thinking: resumeApproval.thinking,
          maxTurns: resumeApproval.maxTurns,
          resultConsumed: false,
          wait: false,
        });
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        record.invocation = resumeInvocation;
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(resumeDetailBase, record));
        }
        const detached = !resumeApproval.runInBackground;
        return textResult(
          detached
            ? `Agent resumed and detached from the parent.\nAgent ID: ${record.id}\nThe parent loop has ended; the child continues in its tmux window.`
            : `Agent resumed in background.\nAgent ID: ${record.id}\nUse get_subagent_result to retrieve full results.`,
          buildDetails(resumeDetailBase, record, undefined, { status: detached ? "detached" : "background" }),
          detached,
        );
      }

      const approved = await withApproval(() => approveInvocation(ctx, ctx.modelRegistry, {
        agentType: subagentType,
        description: params.description,
        prompt: params.prompt,
        model: initialModel,
        thinking,
        maxTurns: requestedMaxTurns,
        runInBackground,
      }, makeApprovalContextInput(ctx)));
      if (approved.outcome === "feedback") {
        return textResult(`feedback: ${approved.feedback}`);
      }
      if (approved.outcome === "do-it-yourself") {
        return textResult("do it yourself");
      }
      if (approved.outcome === "cancel") {
        return textResult("Subagent launch cancelled. No session was created.");
      }

      // Context-ledger finalization: embeds any inherited chain + the new node
      // into the child prompt, and produces the node the child persists.
      const { prompt, ledgerNode, contextMessage } = finalizeLaunchContext(ctx, approved.context, approved.prompt);
      const effectiveModel = approved.model;
      model = effectiveModel;
      thinking = approved.thinking;
      runInBackground = approved.runInBackground;
      const effectiveMaxTurns = approved.maxTurns;
      const parentModelId = ctx.model?.id;
      const effectiveModelId = effectiveModel.id;
      const modelName = effectiveModelId !== parentModelId
        ? (effectiveModel.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const agentInvocation: AgentInvocation = {
        modelName,
        thinking,
        maxTurns: effectiveMaxTurns,
        runInBackground,
      };
      const { tags: agentTags } = buildInvocationTags(agentInvocation);
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // Both parent behaviors launch a notification-backed child and return
      // immediately. "Detach" additionally terminates this parent agent loop;
      // background mode lets the same loop continue.
      const detached = !runInBackground;
      let id: string;
      try {
        id = await manager.spawn(pi, ctx, subagentType, prompt, {
          description: params.description,
          model,
          maxTurns: effectiveMaxTurns,
          thinkingLevel: thinking,
          promptPolicy: rawType?.toLowerCase() === "general-purpose" ? "native" : "inherit",
          isBackground: true,
          invocation: agentInvocation,
          ...(ledgerNode ? { ledgerNode } : {}),
          ...(contextMessage ? { contextMessage } : {}),
          ...(launchSkillsSnapshot === undefined ? {} : { skillsSnapshot: launchSkillsSnapshot }),
        });
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      // Only continue-working launches participate in same-turn group joins.
      const joinMode = resolveJoinMode(defaultJoinMode, runInBackground);
      const record = manager.getRecord(id);
      if (record) {
        record.toolCallId = toolCallId;
        if (joinMode) record.joinMode = joinMode;
      }

      if (joinMode && joinMode !== "async") {
        currentBatchAgents.push({ id, joinMode });
        if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
        batchFinalizeTimer = setTimeout(finalizeBatch, 100);
      }

      pi.events.emit("subagents:created", {
        id,
        type: subagentType,
        description: params.description,
        isBackground: runInBackground,
      });

      const stuckSlots = manager.listAgents().filter((r) =>
        (r.status === "running" || r.status === "awaiting_decision") &&
        (!r.window || r.window.state === "closed")
      ).length;
      const notFoundError = manager.listAgents().find((r) =>
        r.error && /not\s*found|404|provider transport|provider error/i.test(r.error)
      )?.error;
      const isQueued = record?.status === "queued";
      const fallbackNote = fellBack
        ? `Note: Unknown agent type "${rawType}" — using ${resolveType("general-purpose") ? "general-purpose" : "the fallback agent config"}.\n\n`
        : "";
      const launchMode = detached ? "detached from the parent" : "in background";
      return textResult(
        fallbackNote +
        `Agent ${isQueued ? "queued" : "started"} ${launchMode}.\n` +
        `Agent ID: ${id}\n` +
        `Type: ${displayName}\n` +
        `Description: ${params.description}\n` +
        (record?.childSession?.sessionFile ? `Session file: ${record.childSession.sessionFile}\n` : "") +
        (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
        (isQueued && stuckSlots > 0 ? `Note: ${stuckSlots} stuck agent(s) hold concurrency slot(s). Run /ocl to clear them, or wait for a slot.\n` : "") +
        (notFoundError ? providerErrorHint(notFoundError) + "\n" : "") +
        (detached
          ? `\nThe current parent loop has ended. The parent can accept the next user prompt while the child continues.\n`
          : `\nThe current parent loop may continue while the child runs.\n`) +
        `The parent will be notified after the child returns a context checkpoint.\n` +
        `Use get_subagent_result to inspect status without waiting.\n` +
        `Do not duplicate this agent's work.`,
        { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: detached ? "detached" : "background", agentId: id },
        detached,
      );
    },
  }));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a detached or background agent. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a detached or background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait until the child returns a context checkpoint. This can block at the human decision gate. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleared or belong to a prior parent session.`);
      }

      // Wait for completion if requested.
      // Pre-mark resultConsumed BEFORE awaiting: onComplete fires inside .then()
      // (attached earlier at spawn time) and always runs before this await resumes.
      // Setting the flag here prevents a redundant follow-up notification.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued" || record.status === "awaiting_decision")) {
        if (record.status === "running" || record.status === "queued") {
          manager.consumeResult(params.agent_id);
          cancelNudge(params.agent_id);
        }
        while (record.status === "queued") {
          await new Promise((r) => setTimeout(r, 250));
        }
        await manager.waitForSettled(params.agent_id);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = null;
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running" || record.status === "queued") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "awaiting_decision") {
        output += "Status: awaiting human decision\nThe child has produced a response, but no context checkpoint has been returned.\nOpen its tmux window with Alt+A.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued" && record.status !== "awaiting_decision") {
        manager.consumeResult(params.agent_id);
        cancelNudge(params.agent_id);
      }

      // Verbose: point at the persistent session (the child owns the live conversation).
      if (params.verbose) {
        const sessionFile = record.childSession?.sessionFile;
        if (sessionFile) {
          output += `\n\n--- Agent Session ---\nThe agent conversation is persisted at:\n${sessionFile}\n`;
          output += `Open the agent's tmux window to inspect it live, or resume the session via /resume.`;
        } else {
          output += `\n\n(No session file reported yet — the agent may still be starting.)`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- /agents interactive menu ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const workspaceAgentsDir = () => join(process.cwd(), ".agents", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Find the file path of a custom agent by name, in discovery-precedence order (project, workspace, then global). */
  function findAgentFile(name: string): { path: string; location: "project" | "workspace" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const workspacePath = join(workspaceAgentsDir(), `${name}.md`);
    if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    // Configured but unresolvable: the runtime silently falls back to the parent
    // model, so flag it (and the fallback) rather than hiding the config.
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  /** Row label for the /ocl picker: status icon, description, window state. */
  function clearAgentLabel(r: AgentRecord): string {
    const icon = r.status === "awaiting_decision" ? "◆" : r.status === "running" ? "●" : r.status === "queued" ? "◌" : r.status === "idle" ? "◇" : "!";
    const win = r.window ? (r.window.state === "closed" ? "window closed" : `tmux ${r.window.index}`) : "no window";
    return `${icon} ${r.description || r.id} (${r.type}) — ${r.status} · ${win}`;
  }

  /**
   * /ocl — human escape hatch. Clears any agent (zombie or not): kills its
   * tmux window, writes a released marker into the kept mailbox (so restores
   * skip it and /ot stays intact), releases its concurrency slot, and drops
   * the record. Optional first argument matches an agent by id/name/type;
   * without an argument a native SelectList lets the human pick.
   */
  async function clearAgentsCommand(ctx: ExtensionCommandContext, target?: string) {
    const records = manager.listAgents();
    if (records.length === 0) {
      ctx.ui.notify("No agents in this parent session.", "info");
      return;
    }
    if (target) {
      const t = target.trim().toLowerCase();
      const rec = records.find((r) =>
        r.id.toLowerCase().startsWith(t) || r.description.toLowerCase().includes(t) || r.type.toLowerCase().includes(t),
      );
      if (!rec) {
        ctx.ui.notify(`No agent matches "${target}".`, "warning");
        return;
      }
      const outcome = await manager.forceClear(rec.id);
      ctx.ui.notify(
        outcome === "cleared" ? `Cleared "${rec.description}" (${rec.id}). Slot released.` : `Could not clear "${rec.description}" (${rec.id}): ${outcome}`,
        outcome === "cleared" ? "info" : "warning",
      );
      return;
    }
    const options = ["Clear all listed", ...records.map(clearAgentLabel)];
    const selection = await ctx.ui.select("Select an agent to clear (Esc cancels)", options);
    if (!selection) return;
    const ids = selection === "Clear all listed"
      ? records.map((r) => r.id)
      : records.filter((r, i) => options[i + 1] === selection).map((r) => r.id);
    if (ids.length === 0) return;
    let cleared = 0;
    for (const id of ids) {
      if ((await manager.forceClear(id)) === "cleared") cleared++;
    }
    ctx.ui.notify(`Cleared ${cleared} of ${ids.length} selected agent(s). Concurrency slot(s) freed.`, "info");
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);

    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  /** Launch a new agent from an existing /ot ledger context. */
  async function launchAgentFromContext(ctx: ExtensionCommandContext, inheritedNodes: ContextLedgerNode[]) {
    const launchSkillsSnapshot = skillsForLaunch(ctx);
    reloadCustomAgents();
    const available = getAvailableTypes();
    if (available.length === 0) {
      ctx.ui.notify("No enabled agents are available.", "warning");
      return;
    }

    const subagentType = await ctx.ui.select("Invoke agent", available);
    if (!subagentType) return;

    const enteredPrompt = await ctx.ui.editor(`Task for ${getDisplayName(subagentType)}`, "");
    const originalPrompt = enteredPrompt?.trim();
    if (!originalPrompt) return;
    const limitText = await ctx.ui.input("Work-turn limit");
    const maxTurns = Number(limitText);
    try { validateMaxTurns(maxTurns); } catch { ctx.ui.notify("Work-turn limit must be a positive integer.", "warning"); return; }

    const config = getAgentConfig(subagentType);
    const resolvedConfig = resolveAgentInvocationConfig(config, { run_in_background: true });

    let model = ctx.model;
    if (resolvedConfig.modelInput) {
      const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
      if (typeof resolved !== "string") model = resolved;
    }
    if (!model) {
      ctx.ui.notify("Subagent launch blocked: no effective model is available for review.", "warning");
      return;
    }

    if (isScopeModelsEnabled()) {
      const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
      if (allowed && !isModelInScope(model, allowed)) {
        ctx.ui.notify(
          `Agent "${config?.displayName ?? subagentType}" using out-of-scope model "${resolvedConfig.modelInput ?? `${model.provider}/${model.id}`}"`,
          "warning",
        );
      }
    }

    const thinking = clampThinkingLevel(
      model,
      resolvedConfig.thinking ?? pi.getThinkingLevel(),
    ) as ThinkingLevel;
    const description = originalPrompt.split("\n").find(line => line.trim())!.trim().slice(0, 80);

    const approved = await withApproval(() => approveInvocation(ctx, ctx.modelRegistry, {
      agentType: subagentType,
      description,
      prompt: originalPrompt,
      model,
      thinking,
      maxTurns,
      runInBackground: true,
      initialContext: { selectedIds: [], inheritedNodes },
    }));

    if (approved.outcome === "feedback") {
      pi.sendUserMessage(`feedback: ${approved.feedback}`);
      return;
    }
    if (approved.outcome === "do-it-yourself") {
      pi.sendUserMessage("do it yourself");
      return;
    }
    if (approved.outcome === "cancel") return;

    const { prompt, ledgerNode, contextMessage } = finalizeLaunchContext(ctx, approved.context, approved.prompt);
    const effectiveMaxTurns = approved.maxTurns;
    const modelName = approved.model.id !== ctx.model?.id
      ? (approved.model.name ?? approved.model.id).replace(/^Claude\s+/i, "").toLowerCase()
      : undefined;
    const invocation: AgentInvocation = {
      modelName,
      thinking: approved.thinking,
      maxTurns: effectiveMaxTurns,
      runInBackground: approved.runInBackground,
    };

    let id: string;
    const promptPolicy: "native" | "inherit" = subagentType.toLowerCase() === "general-purpose" ? "native" : "inherit";
    try {
      id = await manager.spawn(pi, ctx, subagentType, prompt, {
        description,
        model: approved.model,
        maxTurns: effectiveMaxTurns,
        thinkingLevel: approved.thinking,
        promptPolicy,
        isBackground: true,
        invocation,
        ...(ledgerNode ? { ledgerNode } : {}),
        ...(contextMessage ? { contextMessage } : {}),
        ...(launchSkillsSnapshot === undefined ? {} : { skillsSnapshot: launchSkillsSnapshot }),
      });
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const record = manager.getRecord(id);
    if (record) record.joinMode = "async";
    pi.events.emit("subagents:created", { id, type: subagentType, description, isBackground: approved.runInBackground });
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    ctx.ui.notify(approved.runInBackground
      ? `Started ${getDisplayName(subagentType)} in background (${id}).`
      : `Started ${getDisplayName(subagentType)} and detached (${id}).`, "info");
  }

  /** Build context from this session and launch an unlimited general-purpose agent. */
  async function launchNewAgent(ctx: ExtensionCommandContext) {
    const launchSkillsSnapshot = skillsForLaunch(ctx);
    let branch;
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      ctx.ui.notify("Could not read the current session context.", "warning");
      return;
    }

    const selectedContext = await buildContextUI({ ctx, branch });
    if (!selectedContext) return;
    if (selectedContext.selectedIds.length === 0) {
      ctx.ui.notify("Select at least one context message to start an agent.", "warning");
      return;
    }

    const models = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll()) as Parameters<typeof selectSubagentModel>[1];
    const model = await selectSubagentModel(ctx, models, ctx.model, "Select subagent model");
    if (!model) return;

    if (isScopeModelsEnabled()) {
      const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
      if (allowed && !isModelInScope(model, allowed)) {
        ctx.ui.notify(
          `Selected model "${model.provider}/${model.id}" is outside the enabled model scope.`,
          "warning",
        );
      }
    }

    const thinking = await ctx.ui.select(
      "Select subagent reasoning level",
      availableThinkingLevels(model),
    );
    if (!thinking) return;

    const agentChoice = await ctx.ui.select(
      "Select agent",
      ["inherit (default)", "general purpose"],
    );
    if (!agentChoice) return;

    reloadCustomAgents();
    const resolvedGeneralPurpose = resolveType("general-purpose");
    if (agentChoice === "general purpose" && (!resolvedGeneralPurpose || !getAvailableTypes().includes(resolvedGeneralPurpose))) {
      ctx.ui.notify("No enabled general-purpose agent is available.", "warning");
      return;
    }
    const subagentType = resolvedGeneralPurpose ?? "general-purpose";
    const promptPolicy: "native" | "inherit" = agentChoice === "general purpose" ? "native" : "inherit";
    const agentLabel = agentChoice === "general purpose" ? getDisplayName(subagentType) : "inherited agent";

    const enteredPrompt = await ctx.ui.editor(`Task for ${agentLabel}`, "");
    const prompt = enteredPrompt?.trim();
    if (!prompt) return;

    const description = prompt.split("\n").find(line => line.trim())!.trim().slice(0, 80);
    const approved = await withApproval(() => approveManualLaunch(ctx, {
      agentType: agentChoice === "general purpose" ? subagentType : "inherit (default)",
      description,
      prompt,
      model,
      thinking: thinking as ThinkingLevel,
      runInBackground: true,
      initialContext: { ...selectedContext, inheritedNodes: [] },
    }));

    if (approved.outcome === "feedback") {
      pi.sendUserMessage(`feedback: ${approved.feedback}`);
      return;
    }
    if (approved.outcome === "do-it-yourself") {
      pi.sendUserMessage("do it yourself");
      return;
    }
    if (approved.outcome === "cancel") return;

    const { prompt: launchPrompt, ledgerNode, contextMessage } = finalizeLaunchContext(ctx, approved.context, approved.prompt);
    const invocation: AgentInvocation = {
      thinking: approved.thinking,
      runInBackground: approved.runInBackground,
    };

    let id: string;
    try {
      id = await manager.spawn(pi, ctx, subagentType, launchPrompt, {
        description,
        model: approved.model,
        thinkingLevel: approved.thinking,
        promptPolicy,
        isBackground: true,
        invocation,
        ...(ledgerNode ? { ledgerNode } : {}),
        ...(contextMessage ? { contextMessage } : {}),
        ...(launchSkillsSnapshot === undefined ? {} : { skillsSnapshot: launchSkillsSnapshot }),
      });
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const record = manager.getRecord(id);
    if (record) record.joinMode = "async";
    pi.events.emit("subagents:created", { id, type: subagentType, description, isBackground: approved.runInBackground });
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    ctx.ui.notify(`Started ${getDisplayName(subagentType)} in background (${id}).`, "info");
  }

  /** Alt+A picker: select a fleet row and focus/reopen its tmux window. */
  async function openAgentSessionPicker(ctx: ExtensionContext) {
    const records = fleet.selectableRecords();
    if (records.length === 0) {
      ctx.ui.notify("No agents in this parent session.", "info");
      return;
    }
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    fleet.beginSelection();
    try {
      const selected = await ctx.ui.custom<string | undefined>(
        (_tui, theme, _kb, done) => {
          return {
            render: (w: number) => [formatAgentSessionPickerHint(theme, w)],
            invalidate: () => {},
            handleInput: (data: string) => {
              if (matchesKey(data, "up") || matchesKey(data, "k")) { fleet.moveSelection(-1); return; }
              if (matchesKey(data, "down") || matchesKey(data, "j")) { fleet.moveSelection(1); return; }
              if (matchesKey(data, "enter")) { done(fleet.selectedRecord()?.id); return; }
              if (matchesKey(data, "d")) {
                const rec = fleet.selectedRecord();
                if (!rec) return;
                if (rec.status === "awaiting_decision") {
                  ctx.ui.notify("This agent is waiting for a decision. Open its window and choose Continue, Return, or Feedback.", "info");
                  return;
                }
                // Only finished agents are dismissible here. Running/queued
                // rows are handled by focusing their window or waiting for
                // the launch queue.
                if (rec.status === "running" || rec.status === "queued") {
                  ctx.ui.notify("Only finished agents can be dismissed — focus its window to stop it.", "info");
                  return;
                }
                // Idle children are settled but durable: closing their window
                // keeps the session file, so dismiss is allowed.
                const id = rec.id;
                void manager.dismiss(id).then((outcome) => {
                  if (outcome === "failed") {
                    ctx.ui.notify("Could not close the agent window.", "warning");
                    return;
                  }
                  if (outcome !== "active") {
                    // dismissed / missing — the record is gone; refresh the cursor.
                    if (fleet.selectableRecords().length === 0) { done(undefined); return; }
                    fleet.moveSelection(0);
                  }
                });
                return;
              }
              if (matchesKey(data, "escape") || matchesKey(data, "q")) { done(undefined); return; }
            },
          };
        },
      );
      if (selected) {
        const record = manager.getRecord(selected);
        if (record?.status === "queued") {
          ctx.ui.notify("Agent is still waiting in the launch queue.", "info");
        } else {
          const ok = await manager.focusOrReopen(selected);
          if (!ok) ctx.ui.notify("Could not focus the agent window.", "warning");
        }
      }
    } finally {
      fleet.endSelection();
    }
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    // Build the .md file content
    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.runInBackground) fmFields.push("run_in_background: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const launchSkillsSnapshot = skillsForLaunch(ctx);
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <required positive integer work-turn ceiling; every resume requires a new limit>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
run_in_background: <true to let the current parent loop continue; false detaches and ends that loop>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
      ...(launchSkillsSnapshot === undefined ? {} : { skillsSnapshot: launchSkillsSnapshot }),
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    // 4. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    // 5. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    // Build the file
    const content = `---
description: ${description}${modelLine}${thinkingLine}
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      scopeModels: isScopeModelsEnabled(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent", "defaultMaxTurns", "graceTurns"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent active agent runs (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide the built-in general-purpose agent — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  // ---- /ot context-tree command ----------------

  /** Find the link descriptor that points at a given session file. */
  function findLinkForSessionFile(links: ContextLinkData[], file: string): ContextLinkData | undefined {
    for (const link of links) {
      if (link.childSessionFile === file) return link;
    }
    return undefined;
  }

  /** Route the user to an agent session: active record, else persisted reopen. */
  async function routeToSession(ctx: ExtensionContext, file: string, graphLinks: Map<string, ContextLinkData[]>): Promise<void> {
    const record = manager.recordBySessionFile(file);
    if (record) {
      const ok = await manager.focusOrReopen(record.id);
      if (!ok) ctx.ui.notify("Could not focus the agent window.", "warning");
      return;
    }
    const link = findLinkForSessionFile(graphLinks.get(file) ?? [], file);
    if (!link?.reopen) {
      ctx.ui.notify("No reopen metadata for this session.", "warning");
      return;
    }
    const result = await manager.reopenFromPersisted(link);
    if (!result.ok) {
      ctx.ui.notify("Could not reopen the agent session (session file missing?).", "error");
      return;
    }
    if (result.focused) {
      ctx.ui.notify("Focused the existing agent window.", "info");
    } else {
      if (result.windowName && link.childSessionFile) {
        reopenedWindows.set(link.childSessionFile, result.windowName);
      }
      ctx.ui.notify("Opened the agent session in a new window.", "info");
    }
  }

  async function showContextTree(ctx: ExtensionCommandContext): Promise<void> {
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile) {
      ctx.ui.notify("Context tree requires a persisted session (--no-session cannot rebuild it).", "warning");
      return;
    }

    const graph = loadLedgerGraph(currentFile, readSessionEntries, sessionDisplayName);
    const ancestorFiles = resolveAncestorChain(currentFile).map((a) => a.sessionFile);
    const own = getSessionLedgerNode(plainEntries(readSessionEntries(currentFile)));

    // Map of session file → links pointing at it, for reopen routing.
    const linksByChild = new Map<string, ContextLinkData[]>();
    for (const session of graph.sessions.values()) {
      for (const link of session.links) {
        if (link.childSessionFile) {
          const bucket = linksByChild.get(link.childSessionFile) ?? [];
          bucket.push(link);
          linksByChild.set(link.childSessionFile, bucket);
        }
      }
    }

    await openContextTree({
      ctx,
      graph,
      ancestorFiles,
      currentFile,
      currentLedgerId: own?.id,
      focusOrOpen: async (row) => {
        const file = row.sessionFile;
        if (!file) {
          ctx.ui.notify("No session file for this agent.", "warning");
          return;
        }
        await routeToSession(ctx, file, linksByChild);
      },
      startNewAgent: async (row) => {
        if (!row.node) return;
        const inheritedNodes: ContextLedgerNode[] = [];
        const seen = new Set<string>();
        let node: ContextLedgerNode | undefined = row.node;
        while (node && !seen.has(node.id)) {
          seen.add(node.id);
          inheritedNodes.unshift(node);
          node = node.parentId ? graph.nodes.get(node.parentId) : undefined;
        }
        await launchAgentFromContext(ctx, inheritedNodes);
      },
      launchNewAgent: async () => {
        // Same flow as /otn: build context from the current session, no
        // inheritance required — the row is only the UI anchor.
        await launchNewAgent(ctx);
      },
    });
  }

  pi.registerCommand("ot", {
    description: "Inspect the context-ledger tree and route to agent sessions",
    handler: async (_args, ctx) => { await showContextTree(ctx); },
  });
  pi.registerCommand("otn", {
    description: "start agent manually",
    handler: async (_args, ctx) => { await launchNewAgent(ctx); },
  });
  pi.registerCommand("agents", {
    description: "Manage agent definitions and settings",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
  pi.registerCommand("ocl", {
    description: "Clear agents: kill the tmux window, mark released, free a concurrency slot (keeps session + /ot record)",
    handler: async (_args, ctx) => { await clearAgentsCommand(ctx, Array.isArray(_args) ? _args[0] : typeof _args === "string" ? _args : undefined); },
  });
  pi.registerCommand("agent-session", {
    description: "Select an agent session and focus its tmux window",
    handler: async (_args, ctx) => { await openAgentSessionPicker(ctx); },
  });
  pi.registerShortcut("alt+a", {
    description: "Select an agent session window",
    handler: async (ctx) => { await openAgentSessionPicker(ctx); },
  });
}
