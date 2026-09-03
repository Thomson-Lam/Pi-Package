/**
 * child-host.mjs — Boots a native Pi InteractiveMode for one agent session
 * inside its own tmux window.
 *
 * Usage: node child-host.mjs <launch-spec.json>
 *
 * The spec (written by the parent prepareAgentLaunch) is one-shot: it is
 * deleted immediately after reading. The host:
 *   1. imports @earendil-works/pi-coding-agent from the parent's package dir
 *   2. creates the persistent agent SessionManager (nested under the parent)
 *   3. builds runtime services + session with the approved config
 *   4. subscribes to session events → writes child events to the mailbox
 *   5. polls the mailbox commands dir for follow_up/abort/shutdown
 *   6. runs InteractiveMode with the task prompt
 *   7. emits process_exit and exits when the TUI quits
 *
 * Plain ESM (no TS) so it runs under `node` without a loader.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { keepChildExtension } from "./child-extension-filter.mjs";
import { registerPromptPolicy } from "./prompt-policy.mjs";

// ---- Mailbox helpers (self-contained; keep in sync with event-mailbox.ts) ----

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, filePath);
}

function emitEvent(mailboxDir, event) {
  const file = join(mailboxDir, "events", `${Date.now().toString(36)}-${event.type}.json`);
  writeJsonAtomic(file, event);
}

// ---- Startup ----

const specPath = process.argv[2];
if (!specPath) {
  console.error("[olive-agent] missing launch spec path");
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, "utf-8"));
} catch (err) {
  console.error(`[olive-agent] cannot read launch spec: ${err.message}`);
  process.exit(1);
}
// One-shot spec: delete after reading.
try { rmSync(specPath, { force: true }); } catch {}

let codingAgent;
try {
  // The standalone Pi binary has no Node-readable dist/index.js. The child
  // runs under Node, so resolve the SDK from the normal Node module graph first.
  codingAgent = await import("@earendil-works/pi-coding-agent");
} catch (moduleError) {
  // Compatibility fallback for older npm/source installations whose package
  // root is explicitly supplied in the launch spec.
  try {
    codingAgent = await import(pathToFileURL(join(spec.runtime.packageDir, "dist", "index.js")));
  } catch (fallbackError) {
    const message = `child SDK startup failed: ${fallbackError?.message ?? moduleError?.message ?? fallbackError}`;
    console.error(`[olive-agent] ${message}`);
    try {
      emitEvent(spec.bridge.mailboxDir, {
        type: "run_settled",
        runNumber: 0,
        status: "error",
        error: message,
        turnCount: 0,
        toolUses: 0,
        releaseReason: "error",
      });
    } catch {}
    process.exit(1);
  }
}

const { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, getAgentDir, ModelRuntime, InteractiveMode } = codingAgent;

// ---- Session + runtime ----

const sessionManager = spec.session.openFile
  ? SessionManager.open(spec.session.openFile)
  : SessionManager.create(
      spec.runtime.cwd,
      spec.session.sessionDir || undefined,
      { id: spec.session.id, parentSession: spec.session.parentFile },
    );

const modelRuntime = await ModelRuntime.create();
let model = modelRuntime.getModel(spec.runtime.model.provider, spec.runtime.model.id);
if (!model) {
  const available = await modelRuntime.getAvailable();
  model = available[0];
  console.error(`[olive-agent] model ${spec.runtime.model.provider}/${spec.runtime.model.id} not found; falling back to ${model?.provider}/${model?.id ?? "none"}`);
}
if (!model) {
  console.error("[olive-agent] no model available (missing credentials?)");
  process.exit(1);
}

let nativeSystemPrompt;
let bridgeContext;
let bridgePi;

const bridgeFactory = (pi) => {
  bridgePi = pi;
  // Restore the native prompt after other extensions have processed the hook.
  registerPromptPolicy(pi, spec.runtime.promptPolicy, () => nativeSystemPrompt);

  pi.on("session_start", (_event, ctx) => { bridgeContext = ctx; });

  /**
   * /or may only return context to a parent, so it must no-op when the
   * current session is not a child (no parentSession in the JSONL header).
   * The header is authoritative for reopened sessions; the launch spec's
   * parentFile is the fallback for fresh sessions.
   */
  const isChildSession = () => {
    try {
      const entries = sessionManager?.getEntries?.() ?? [];
      const header = entries.find((e) => e?.type === "session");
      if (header) return Boolean(header.parentSession);
    } catch { /* fall through to spec */ }
    return Boolean(spec?.session?.parentFile);
  };

  // Register /or only for genuine children: a parent session must never even
  // expose the command, regardless of how the bridge happens to load.
  if (isChildSession()) {
  pi.registerCommand("or", {
    description: "Return new child context to the parent",
    handler: async (_args, ctx) => {
      if (inRun || session?.isStreaming) {
        ctx.ui.notify?.("Wait for the current response before opening /or.", "warning");
        return;
      }
      const decision = pendingDecision ?? {
        runNumber: Math.max(1, runNumber), reason: "completed",
        result: assistantText(lastAssistant(session)), turnCount,
        maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(),
        compactions, usage: usageOf(session),
      };
      await returnContext(decision, ctx);
    },
  });
  }
  // Any direct human work transfers control from the delegated automatic run
  // to an unlimited interactive conversation. The initial task payload is
  // delivered through the same input channel but is NOT a human intervention,
  // so the mode switch is gated on the session having actually started work.
  pi.on("input", (event) => {
    const text = typeof event?.text === "string" ? event.text : "";
    if (event?.source === "interactive" && text.trim() && text.trim() !== "/or") {
      if (workStarted) {
        enterInteractiveMode();
        if (pendingDecision && !decisionGateActive) clearPendingForContinuation();
      }
    }
    if (event?.source === "interactive" && event.streamingBehavior && text.trim()) {
      emitEvent(spec.bridge.mailboxDir, { type: "human_steer", runNumber, text: text.slice(0, 500) });
    }
  });
};

const createRuntime = async ({ cwd, agentDir, sessionManager: sm }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: spec.runtime.noExtensions,
      additionalExtensionPaths: spec.runtime.extensionPaths.length > 0 ? spec.runtime.extensionPaths : undefined,
      extensionsOverride: spec.runtime.noExtensions
        ? undefined
        : (base) => ({
            ...base,
            // The allow-list contains parent extension file paths, but the
            // child-return bridge is an inline extension. Preserve it or /or
            // is filtered out before the child session is bound.
            extensions: base.extensions.filter((extension) =>
              keepChildExtension(extension.path, spec.runtime.extensionPaths)
            ),
          }),
      noSkills: spec.runtime.noSkills,
      // An Olive snapshot is authoritative, including an empty array. Let Pi
      // install it through its native resource loader so prompt metadata and
      // /skill:* commands use the same resolved resources as the parent.
      ...(spec.runtime.skillsSnapshotAuthoritative === true
        ? {
            skillsOverride: () => ({
              skills: Array.isArray(spec.runtime.skillsSnapshot) ? spec.runtime.skillsSnapshot : [],
              diagnostics: [],
            }),
          }
        : {}),
      noPromptTemplates: true,
      noThemes: false,
      noContextFiles: true,
      ...(spec.runtime.systemPrompt === undefined
        ? {}
        : {
            systemPromptOverride: () => spec.runtime.systemPrompt,
            appendSystemPromptOverride: () => [],
          }),
      extensionFactories: [{ name: "olive-agent-bridge", factory: bridgeFactory }],
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: sm,
    model,
    thinkingLevel: spec.runtime.thinking,
    tools: spec.runtime.tools,
  });
  nativeSystemPrompt = result.session.systemPrompt;
  return { ...result, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: spec.runtime.cwd,
  agentDir: getAgentDir(),
  sessionManager,
});

let session = runtime.session;
session.setSessionName(spec.session.name);

// ---- State + event subscription ----

let inRun = false;
let runNumber = 0;
let turnCount = 0;
let toolUses = 0;
let parentAborted = false;
let compactions = 0;
let currentMaxTurns = spec.run.maxTurns;
let ceilingTriggered = false;
let reconciliationRun = false;
let pendingDecision = null;
let decisionGateActive = false;
let interactiveMode = false;
let workStarted = false;
let originalTools = session.getActiveToolNames();
const pendingDecisionPath = join(spec.bridge.mailboxDir, "pending-decision.json");
const bridgeStatePath = join(spec.bridge.mailboxDir, "bridge-state.json");
try { pendingDecision = JSON.parse(readFileSync(pendingDecisionPath, "utf-8")); } catch {}
if (pendingDecision?.runNumber) {
  runNumber = pendingDecision.runNumber;
  currentMaxTurns = pendingDecision.maxTurns;
  workStarted = true;
}
// Manual unlimited launches (/otn, /ot → Launch an agent) run interactive from
// the start: there is no ceiling, and completion must never open the automatic
// decision gate — the human returns context explicitly with /or. Limited
// launches (Agent tool, /ot → Start new agent, parent resumes) stay automatic.
// Only fresh launches derive the mode from the spec; reopens trust the
// persisted control-mode entry.
if (!spec.session.openFile && currentMaxTurns === undefined) {
  enterInteractiveMode();
  workStarted = true;
}
// Record the boot state for the parent: reopened children start idle (or
// awaiting a restored decision); fresh spawns are corrected by run_started.
persistBridgeState(pendingDecision ? "awaiting_decision" : "idle");
try {
  const modeEntries = sessionManager.getEntries().filter((entry) =>
    entry?.type === "custom" && entry.customType === "olive-agent-control-mode"
  );
  interactiveMode = modeEntries.at(-1)?.data?.mode === "interactive";
  if (interactiveMode) {
    currentMaxTurns = undefined;
    workStarted = true;
  }
} catch {}

function targetOf(args) {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.command === "string") return args.command.replace(/\s+/g, " ").slice(0, 80);
  if (typeof args.path === "string") return args.path;
  if (typeof args.pattern === "string") return args.pattern.slice(0, 60);
  return undefined;
}

function lastAssistant(s) {
  const messages = s.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function assistantText(msg) {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n").trim();
  }
  return "";
}

function settledStatus() {
  if (parentAborted) return "stopped";
  const last = lastAssistant(session);
  if (last?.stopReason === "error") return "error";
  if (last?.stopReason === "aborted") return "stopped";
  return "completed";
}

function usageOf(s) {
  try {
    const t = s.getSessionStats?.()?.tokens;
    return t ? { input: t.input ?? 0, output: t.output ?? 0, cacheWrite: t.cacheWrite ?? 0 } : undefined;
  } catch { return undefined; }
}

function persistBridgeState(status) {
  try {
    writeJsonAtomic(bridgeStatePath, {
      version: 1,
      status,
      mode: interactiveMode ? "interactive" : "automatic",
      runNumber,
      turnCount,
      maxTurns: currentMaxTurns,
      updatedAt: Date.now(),
    });
  } catch {}
}

function emitInteractiveIdle(reason) {
  persistBridgeState("idle");
  emitEvent(spec.bridge.mailboxDir, {
    type: "run_idle",
    runNumber,
    reason,
    turnCount,
    toolUses,
    maxTurns: currentMaxTurns,
  });
}

function enterInteractiveMode() {
  if (interactiveMode) return;
  interactiveMode = true;
  currentMaxTurns = undefined;
  ceilingTriggered = false;
  try { session.setActiveToolsByName(originalTools); } catch {}
  try { bridgePi?.appendEntry?.("olive-agent-control-mode", { version: 1, mode: "interactive", changedAt: new Date().toISOString() }); } catch {}
  persistBridgeState(inRun ? "running" : "idle");
}

function enterAutomaticMode(maxTurns) {
  interactiveMode = false;
  currentMaxTurns = maxTurns;
  ceilingTriggered = false;
  try { bridgePi?.appendEntry?.("olive-agent-control-mode", { version: 1, mode: "automatic", changedAt: new Date().toISOString() }); } catch {}
  persistBridgeState(inRun ? "running" : "idle");
}

function clearPendingForContinuation() {
  pendingDecision = null;
  ceilingTriggered = false;
  reconciliationRun = false;
  parentAborted = false;
  try { rmSync(pendingDecisionPath, { force: true }); } catch {}
  try { session.setActiveToolsByName(originalTools); } catch {}
}

async function buildReturnCheckpoint(decision, ctx = bridgeContext) {
  if (!bridgePi?.events?.emit) throw new Error("child return bridge is unavailable");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result?.error) reject(new Error(result.error));
      else resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "context builder did not respond" }), 60_000 * 30);
    bridgePi.events.emit("olive-agents:return-context-request", {
      agentId: spec.agent.id,
      reason: decision.reason === "turn_limit" ? "turn_limit" : decision.reason === "aborted" ? "interrupted" : "completed",
      ctx,
      respond: finish,
    });
  });
}

async function returnContext(decision, ctx = bridgeContext) {
  if (inRun || session.isStreaming) {
    ctx?.ui?.notify?.("Wait for the current response before returning.", "warning");
    return false;
  }
  try {
    const built = await buildReturnCheckpoint(decision, ctx);
    if (!built?.checkpoint) return false;
    emitEvent(spec.bridge.mailboxDir, {
      type: "context_checkpoint",
      runNumber: decision.runNumber,
      checkpoint: built.checkpoint,
    });
  } catch (err) {
    ctx?.ui?.notify?.(`Could not return child context: ${err?.message ?? err}`, "error");
    return false;
  }
  pendingDecision = null;
  try { rmSync(pendingDecisionPath, { force: true }); } catch {}
  persistBridgeState("idle");
  ctx?.ui?.notify?.("Selected child context returned to the parent.", "info");
  return true;
}

async function waitForBridgeContext() {
  for (let attempt = 0; attempt < 100 && !bridgeContext; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return bridgeContext;
}

async function showDecisionGate(decision) {
  if (decisionGateActive || !decision) return;
  decisionGateActive = true;
  pendingDecision = decision;
  try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
  persistBridgeState("awaiting_decision");
  emitEvent(spec.bridge.mailboxDir, { type: "decision_required", ...decision });
  const title = decision.reason === "turn_limit" ? "Turn limit reached" : "Agent response ready";
  let continuationPrompt;
  try {
    const ctx = await waitForBridgeContext();
    if (!ctx?.ui?.select) throw new Error("child TUI context is unavailable");
    const choice = await ctx.ui.select(title, ["Continue", "Return to parent", "Feedback"]);
    if (choice === "Continue") {
      clearPendingForContinuation();
      continuationPrompt = "Continue.";
    } else if (choice === "Feedback") {
      const feedback = await ctx.ui.editor?.("Feedback for agent", "");
      if (feedback?.trim()) {
        clearPendingForContinuation();
        continuationPrompt = feedback;
      }
    } else if (choice === "Return to parent") {
      await returnContext(decision, ctx);
    } else if (choice === undefined) {
      // Escape/Ctrl+C cancels the outer decision selector. Transfer control to
      // the native editor instead of leaving the parent parked at the gate.
      enterInteractiveMode();
      clearPendingForContinuation();
      emitInteractiveIdle("interrupted");
    } else {
      ctx.ui.notify?.("Decision remains pending. Use /or to return, or enter another prompt to continue.", "info");
    }
  } catch (err) {
    bridgeContext?.ui?.notify?.(`Decision UI failed: ${err?.message ?? err}. Use /or to return.`, "warning");
  } finally {
    decisionGateActive = false;
  }
  // Start only after this selector fully closes. Otherwise a fast next run can
  // settle while decisionGateActive is still true and lose its next selector.
  if (continuationPrompt) {
    try {
      await session.prompt(continuationPrompt, { source: "extension" });
    } catch (err) {
      bridgeContext?.ui?.notify?.(`Could not continue the agent: ${err?.message ?? err}`, "warning");
      await showDecisionGate(decision);
    }
  }
}

async function requestReconciliation(s) {
  reconciliationRun = true;
  try {
    await s.prompt("The work-turn limit has been reached. Do not continue executing the task. Report current status for the human: work completed, remaining work, blockers, and the next action you would take.", { source: "extension" });
  } catch {
    reconciliationRun = false;
    await showDecisionGate({ runNumber, reason: "turn_limit", result: "No status response was produced. Review the session before deciding.", turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) });
  }
}

function subscribeTo(s) {
  return s.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        if (!inRun) {
          inRun = true;
          persistBridgeState("running");
          if (!reconciliationRun) {
            workStarted = true;
            runNumber++;
            turnCount = 0;
            toolUses = 0;
            parentAborted = false;
            emitEvent(spec.bridge.mailboxDir, { type: "run_started", runNumber, maxTurns: currentMaxTurns, mode: interactiveMode ? "interactive" : "automatic" });
          }
        }
        break;
      case "turn_end": {
        if (reconciliationRun) break;
        // Count only turns in this delegated run; the native session's turn
        // index may span resumed runs.
        turnCount += 1;
        emitEvent(spec.bridge.mailboxDir, { type: "turn_finished", runNumber, turnCount });
        if (currentMaxTurns != null && turnCount >= currentMaxTurns && !ceilingTriggered) {
          ceilingTriggered = true;
          try { s.setActiveToolsByName([]); } catch {}
          void s.abort();
        }
        break;
      }
      case "tool_execution_start":
        emitEvent(spec.bridge.mailboxDir, { type: "tool_started", runNumber, toolName: event.toolName, target: targetOf(event.args) });
        break;
      case "tool_execution_end":
        if (!reconciliationRun) toolUses++;
        emitEvent(spec.bridge.mailboxDir, { type: "tool_finished", runNumber, toolName: event.toolName });
        break;
      case "compaction_end":
        if (!event.aborted && event.result) compactions++;
        break;
      case "agent_settled": {
        if (!inRun) break;
        inRun = false;
        const status = settledStatus();
        const result = assistantText(lastAssistant(session));
        if (reconciliationRun) {
          reconciliationRun = false;
          const decision = { runNumber, reason: "turn_limit", result: result || "No status response was produced. Review the session before deciding.", turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) };
          if (interactiveMode) {
            pendingDecision = decision;
            try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
            emitInteractiveIdle("turn_limit");
            bridgeContext?.ui?.notify?.("Interactive response ready. Use /or when you want to return selected context to the parent.", "info");
          } else {
            void showDecisionGate(decision);
          }
          break;
        }
        if (ceilingTriggered) {
          void requestReconciliation(s);
          break;
        }
        if (status === "completed") {
          const decision = { runNumber, reason: "completed", result: result || undefined, turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) };
          if (interactiveMode) {
            pendingDecision = decision;
            try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
            emitInteractiveIdle("completed");
            bridgeContext?.ui?.notify?.("Interactive response ready. Use /or when you want to return selected context to the parent.", "info");
          } else {
            void showDecisionGate(decision);
          }
        } else if (status === "stopped") {
          // A human stop transfers control to an unlimited interactive session.
          enterInteractiveMode();
          const decision = { runNumber, reason: "aborted", result: result || undefined, turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) };
          pendingDecision = decision;
          try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
          emitInteractiveIdle("interrupted");
          bridgeContext?.ui?.notify?.("Agent stopped and switched to interactive mode. Use /or to return selected context, or enter a prompt to continue.", "info");
        } else if (status === "error") {
          // Unrecoverable failure: surface it so the parent cannot wait forever.
          emitEvent(spec.bridge.mailboxDir, { type: "run_settled", runNumber, status, result: result || undefined, error: "provider error with no output", turnCount, toolUses, compactions, usage: usageOf(s), releaseReason: "error" });
        }
        // "stopped" (parent abort command or a human Escape in the child) is
        // NOT a release: the parent must receive nothing until the human
        // chooses Return to parent, /or, Continue, or Feedback.
        break;
      }
    }
  });
}

let unsubscribe = subscribeTo(session);

// Detect session replacement (/new, /resume inside the child TUI) and
// re-subscribe to the new session.
let lastSession = session;

// ---- Command polling (parent → child) ----

let shuttingDown = false;

async function processCommands() {
  const { readdirSync } = await import("node:fs");
  const dir = join(spec.bridge.mailboxDir, "commands");
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return; }

  for (const file of files) {
    const path = join(dir, file);
    let cmd;
    try { cmd = JSON.parse(readFileSync(path, "utf-8")); } catch {
      try { rmSync(path, { force: true }); } catch {}
      continue;
    }
    try { rmSync(path, { force: true }); } catch {} // consume exactly once

    try {
      switch (cmd.type) {
        case "follow_up":
          if (!Number.isInteger(cmd.maxTurns) || cmd.maxTurns < 1) {
            bridgeContext?.ui?.notify?.("Resume rejected: max_turns must be a positive integer.", "error");
            break;
          }
          enterAutomaticMode(cmd.maxTurns);
          clearPendingForContinuation();
          if (session.isStreaming) await session.followUp(cmd.message);
          else await session.prompt(cmd.message, { source: "extension" });
          break;
        case "abort":
          parentAborted = true;
          await session.abort();
          break;
        case "ack_checkpoint":
          try {
            bridgePi?.appendEntry?.("olive-agent-context-return-ack", {
              version: 1,
              checkpointId: cmd.checkpointId,
              acknowledgedAt: new Date().toISOString(),
            });
          } catch {}
          break;
        case "shutdown":
          shuttingDown = true;
          process.exit(0);
          break;
      }
    } catch (err) {
      console.error(`[olive-agent] command ${cmd.type} failed: ${err?.message ?? err}`);
    }
  }
}

const commandTimer = setInterval(() => {
  void processCommands();
  // Re-subscribe if the runtime replaced the session.
  if (runtime.session !== lastSession) {
    unsubscribe();
    session = runtime.session;
    lastSession = session;
    try { session.setSessionName(spec.session.name); } catch {}
    unsubscribe = subscribeTo(session);
  }
}, 500);
commandTimer.unref?.();

// ---- Ready + run ----

emitEvent(spec.bridge.mailboxDir, {
  type: "ready",
  sessionId: sessionManager.getSessionId(),
  sessionFile: sessionManager.getSessionFile(),
});

// Persist the context ledger node into THIS session before the task runs. Only
// for fresh sessions (reopened sessions already have their ledger entry). The
// entry is a pi custom entry: durable, but never part of the LLM context.
if (!spec.session.openFile && spec.ledger?.node) {
  try {
    sessionManager.appendCustomEntry("olive-agent-context-ledger", { version: 1, node: spec.ledger.node });
  } catch (err) {
    console.error(`[olive-agent] failed to persist context ledger: ${err?.message ?? err}`);
  }
  // Attached context is delivered as a custom message (same type as returns)
  // so the child sees context + instructions separately; it participates in
  // LLM context and persists as a custom_message entry, never as a user blob.
  if (spec.ledger.message) {
    try {
      sessionManager.appendCustomMessageEntry(
        "subagent-context-checkpoint",
        spec.ledger.message,
        true,
        { direction: "attached", ledgerNodeId: spec.ledger.node.id },
      );
    } catch (err) {
      console.error(`[olive-agent] failed to append attached context: ${err?.message ?? err}`);
    }
  }
}

// At-least-once checkpoint delivery: a parent acknowledges only after its
// session persisted the returned context. Reopening re-emits anything unacked.
try {
  const entries = sessionManager.getEntries();
  const acknowledged = new Set(entries
    .filter((entry) => entry?.type === "custom" && entry.customType === "olive-agent-context-return-ack")
    .map((entry) => entry.data?.checkpointId)
    .filter((id) => typeof id === "string"));
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== "olive-agent-context-return") continue;
    const checkpoint = entry.data;
    if (!checkpoint?.id || acknowledged.has(checkpoint.id)) continue;
    emitEvent(spec.bridge.mailboxDir, { type: "context_checkpoint", runNumber: Math.max(1, runNumber), checkpoint });
  }
} catch {}

const mode = new InteractiveMode(runtime, {
  initialMessage: spec.run.prompt || undefined,
  verbose: false,
});

try {
  const modeRun = mode.run();
  // Reopening a child must restore the pending decision without resending the
  // original task. The selector is native Pi UI and the durable state survives
  // an accidental tmux window close.
  if (pendingDecision) setTimeout(() => {
    if (interactiveMode || pendingDecision.reason === "aborted") {
      bridgeContext?.ui?.notify?.("Interactive child context is waiting. Use /or to review and return it.", "info");
    } else {
      void showDecisionGate(pendingDecision);
    }
  }, 500);
  await modeRun;
} catch (err) {
  console.error(`[olive-agent] interactive mode failed: ${err?.message ?? err}`);
  // Surface as an error settlement so the parent does not wait forever.
  emitEvent(spec.bridge.mailboxDir, {
    type: "run_settled",
    runNumber: Math.max(1, runNumber),
    status: "error",
    error: `child TUI failed: ${err?.message ?? String(err)}`,
    turnCount,
    toolUses,
    compactions,
    releaseReason: "error",
  });
} finally {
  clearInterval(commandTimer);
  unsubscribe();
  if (!shuttingDown) emitEvent(spec.bridge.mailboxDir, { type: "process_exit" });
  try { await runtime.dispose(); } catch {}
  process.exit(0);
}
