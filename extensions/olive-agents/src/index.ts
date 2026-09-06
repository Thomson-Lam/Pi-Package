/**
 * pi-agents — A pi extension providing human-supervised child agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
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
import { approveInvocation, buildLedgerContext, selectInheritedContext, type ApprovalContextInput, type BuiltLedgerContext } from "./approval.js";
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
import { loadCustomAgents } from "./custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type SubagentType, type ThinkingLevel } from "./types.js";
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
import { clearParentWindow, execFromPi, findWindowByName, focusWindow, markParentWindow } from "./tmux-window.js";
import { openContextTree } from "./ui/context-tree.js";
import { buildContextUI } from "./ui/context-selection.js";
import { getLifetimeTotal, type LifetimeUsage } from "./usage.js";

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

export default function (pi: ExtensionAPI) {
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

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

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

  // Lifecycle completion is retained as session-local bookkeeping only. It
  // never sends a follow-up or triggers a parent turn.
  const manager = new AgentManager((record) => {
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    pi.events.emit(isError ? "subagents:failed" : "subagents:completed", eventData);
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });
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
    onContextCheckpoint: (record, checkpoint) => {
      if (receivedCheckpointIds.has(checkpoint.id)) {
        manager.acknowledgeCheckpoint(record.id, checkpoint.id);
        return;
      }
      const markdown = contextReturnToMarkdown(checkpoint);
      // Markdown-only format: `## context` plus the returned context sections.
      // No XML wrapper, no metadata bullets, no footer.
      const content = markdown;
      // Serialize only concurrent returns or a busy parent. The checkpoint
      // message must be inserted before its durable receipt and child ack.
      checkpointDeliveryTail = checkpointDeliveryTail.then(async () => {
        await waitUntilParentIdle();
        if (receivedCheckpointIds.has(checkpoint.id)) {
          manager.acknowledgeCheckpoint(record.id, checkpoint.id);
          return;
        }
        try {
          await Promise.resolve(pi.sendMessage(
            { customType: "subagent-context-checkpoint", content, display: true, details: { checkpointId: checkpoint.id, agentId: record.id, markdown } },
            { deliverAs: "followUp", triggerTurn: !checkpoint.note },
          ));
          pi.appendEntry("olive-agent-context-return-received", {
            version: 1,
            checkpointId: checkpoint.id,
            agentId: record.id,
            receivedAt: new Date().toISOString(),
          });
          receivedCheckpointIds.add(checkpoint.id);
          manager.acknowledgeCheckpoint(record.id, checkpoint.id);
          // A note is deliberately sent last: it is the only additional
          // parent prompt and therefore follows the inserted context.
          if (checkpoint.note) pi.sendUserMessage(checkpoint.note, { deliverAs: "steer" });
        } catch (error) {
          // Do not record receipt or ack when insertion failed. The child will
          // re-emit the checkpoint when the parent is reopened.
          console.error("[olive-agents] failed to persist returned child context:", error instanceof Error ? error.message : error);
        }
      }).catch(() => { /* keep the return queue usable after one failure */ });
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

  // Parent session lifecycle and durable child restoration.
  let currentCtx: ExtensionContext | undefined;
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    try {
      const marked = await markParentWindow(
        execFromPi(pi),
        ctx.sessionManager.getSessionFile(),
      );
      if (!marked) console.error("[olive-agents] failed to mark parent tmux window");
    } catch (error) {
      console.error("[olive-agents] failed to mark parent tmux window:", error instanceof Error ? error.message : error);
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
    manager.setParentSessionFile(ctx.sessionManager.getSessionFile());
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    const latestLinks = new Map<string, ContextLinkData>();
    for (const link of getSessionLinks(ctx.sessionManager.getEntries())) latestLinks.set(link.agentId, link);
    for (const link of latestLinks.values()) {
      try { await manager.restoreFromPersisted(link); } catch { /* stale links are ignored */ }
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
    manager.setParentSessionFile(undefined);
  });

  // On shutdown, detach local tracking without stopping child hosts. Each child
  // owns its tmux window and must survive the parent Pi window closing.
  pi.on("session_shutdown", async () => {
    void clearParentWindow(execFromPi(pi)).catch(() => {});
    currentCtx = undefined;
    unsubscribeReturnBuilder();
    fleet.dispose();
    manager.dispose();
  });

  // Passive compact overview below the editor.
  const fleet = new FleetList(manager);

  // Agent sessions reopened from /ot (no manager record exists). Keyed by
  // session file → tmux window name, so the session_before_switch guard can
  // prevent opening a live agent JSONL in the parent TUI.
  const reopenedWindows = new Map<string, string>();

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
  async function withApproval<T>(show: () => Promise<T>): Promise<T> {
    const previous = approvalTail;
    let release!: () => void;
    approvalTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await show();
    } finally {
      release();
    }
  }

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch a supervised child agent for complex, multi-step tasks. The child runs in its own tmux window and is detached from the parent. It returns context only when the human chooses Return.

Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained.
- max_turns is required and positive.
- The child uses the parent working directory, tools, and extensions.`;

  const fullAgentToolDescription = `Launch a new supervised child agent for complex, multi-step tasks. The child runs in its own tmux window and is detached from the parent. Human control remains in the child window; Continue, Feedback, and Return are decided there.

Available agent types and tools:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

When using Agent:
- Include a short 3-5 word description shown in the UI.
- Provide a self-contained prompt and a required positive max_turns.
- Successful launches terminate the current parent loop. The parent is not woken for completion, errors, or child steering.
- Return is the only child action that sends context to the parent.

The child uses the parent working directory, active tools, and loaded extensions.`;

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
    promptSnippet: "Launch supervised child agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type. Otherwise use direct tools (read, grep, find) when the target is already known.",
      "Successful launches are detached; the parent is not woken for completion, errors, or steering. Supervise the child window and wait for the human to choose Return.",
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
        description: "Required positive work-turn ceiling.",
        minimum: 1,
      }),
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
        const label = "Detached from child";
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

    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType | undefined;
      const resolved = rawType ? resolveType(rawType) : undefined;
      const subagentType = resolved ?? "general-purpose";
      const fellBack = rawType !== undefined && resolved === undefined;
      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolvedModel = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolvedModel);
        } else {
          model = resolvedModel;
        }
      }
      if (isScopeModelsEnabled() && model) {
        const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
        if (allowed && !isModelInScope(model, allowed) && resolvedConfig.modelFromParams) {
          const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
          return textResult(`Model not in scope: "${resolvedConfig.modelInput}".\n\nAllowed models (from enabledModels):\n${list}`);
        }
      }
      if (!model) return textResult("Subagent launch blocked: no effective model is available.");

      let thinking = clampThinkingLevel(model, resolvedConfig.thinking ?? pi.getThinkingLevel()) as ThinkingLevel;
      try { validateMaxTurns(params.max_turns); } catch (err) { return textResult(err instanceof Error ? err.message : String(err)); }
      const requestedMaxTurns = params.max_turns as number;

      const approved = await withApproval(() => approveInvocation(ctx, ctx.modelRegistry, {
        agentType: subagentType,
        description: params.description,
        prompt: params.prompt,
        model,
        thinking,
        maxTurns: requestedMaxTurns,
      }, makeApprovalContextInput(ctx)));
      if (approved.outcome === "feedback") return textResult(`feedback: ${approved.feedback}`);
      if (approved.outcome === "do-it-yourself") return textResult("do it yourself");
      if (approved.outcome === "cancel") return textResult("Subagent launch cancelled. No session was created.");

      const { prompt, ledgerNode, contextMessage } = finalizeLaunchContext(ctx, approved.context, approved.prompt);
      model = approved.model;
      thinking = approved.thinking;
      const effectiveMaxTurns = approved.maxTurns;
      const modelName = model.id !== ctx.model?.id
        ? (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const agentInvocation: AgentInvocation = { modelName, thinking, maxTurns: effectiveMaxTurns };
      const { tags: agentTags } = buildInvocationTags(agentInvocation);
      const detailBase = { displayName, description: params.description, subagentType, modelName, tags: agentTags.length ? agentTags : undefined };

      let id: string;
      try {
        id = await manager.spawn(pi, ctx, subagentType, prompt, {
          description: params.description,
          model,
          maxTurns: effectiveMaxTurns,
          thinkingLevel: thinking,
          promptPolicy: rawType?.toLowerCase() === "general-purpose" ? "native" : "inherit",
          invocation: agentInvocation,
          ...(ledgerNode ? { ledgerNode } : {}),
          ...(contextMessage ? { contextMessage } : {}),
        });
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const record = manager.getRecord(id);
      if (record) record.toolCallId = toolCallId;
      pi.events.emit("subagents:created", { id, type: subagentType, description: params.description });
      const fallbackNote = fellBack
        ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n`
        : "";
      return textResult(
        fallbackNote +
        `Agent ${record?.status === "queued" ? "queued" : "started"} detached from the parent.\n` +
        `Agent ID: ${id}\nType: ${displayName}\nDescription: ${params.description}\n` +
        (record?.childSession?.sessionFile ? `Session file: ${record.childSession.sessionFile}\n` : "") +
        `\nThe parent will not be woken by completion, errors, or child steering.\n` +
        `The human can supervise the child in its tmux window and choose Return when context should come back.\n` +
        `Do not duplicate this agent's work.`,
        { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "detached", agentId: id },
        true,
      );
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
    const resolvedConfig = resolveAgentInvocationConfig(config, {});

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
        invocation,
        ...(ledgerNode ? { ledgerNode } : {}),
        ...(contextMessage ? { contextMessage } : {}),
      });
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const record = manager.getRecord(id);
    pi.events.emit("subagents:created", { id, type: subagentType, description });
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    ctx.ui.notify(`Started ${getDisplayName(subagentType)} detached (${id}).`, "info");
  }

  /** Build context from this session and launch an unlimited parent-prompt agent. */
  async function launchNewAgent(ctx: ExtensionCommandContext) {
    let branch;
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      ctx.ui.notify("Could not read the current session context.", "warning");
      return;
    }

    const selectedContext = await buildContextUI({
      ctx,
      branch,
      nextHint: "existing context?",
    });
    if (!selectedContext) return;

    const contextInput = makeApprovalContextInput(ctx);
    const inheritedNodes = contextInput
      ? await selectInheritedContext(ctx, contextInput)
      : [];
    const builtContext = selectedContext.selectedIds.length > 0 || inheritedNodes.length > 0
      ? { ...selectedContext, inheritedNodes }
      : undefined;

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("Subagent launch blocked: no effective model is available.", "warning");
      return;
    }
    const thinking = clampThinkingLevel(model, pi.getThinkingLevel()) as ThinkingLevel;
    const subagentType = "general-purpose";
    const promptPolicy: "inherit" = "inherit";

    const enteredPrompt = await ctx.ui.editor("Task for Agent", "");
    const prompt = enteredPrompt?.trim();
    if (!prompt) return;

    const description = prompt.split("\n").find(line => line.trim())!.trim().slice(0, 80);
    const approved = await withApproval(() => approveInvocation(ctx, ctx.modelRegistry, {
      agentType: subagentType,
      description,
      prompt,
      model,
      thinking,
      maxTurns: undefined,
      ...(builtContext ? { initialContext: builtContext } : {}),
    }, contextInput));

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
    };

    let id: string;
    try {
      id = await manager.spawn(pi, ctx, subagentType, launchPrompt, {
        description,
        model: approved.model,
        thinkingLevel: approved.thinking,
        promptPolicy,
        invocation,
        ...(ledgerNode ? { ledgerNode } : {}),
        ...(contextMessage ? { contextMessage } : {}),
      });
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
      return;
    }

    const record = manager.getRecord(id);
    pi.events.emit("subagents:created", { id, type: subagentType, description });
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    ctx.ui.notify(`Started ${getDisplayName(subagentType)} detached (${id}).`, "info");
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
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    try {
      const id = await manager.spawn(pi, ctx, "general-purpose", generatePrompt, {
        description: `Generate ${name} agent`,
        maxTurns: 5,
        promptPolicy: "native",
      });
      ctx.ui.notify(`Agent definition generation started in a supervised child (${id}).`, "info");
    } catch (err) {
      ctx.ui.notify(`Generation launch failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
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
