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

const bridgeFactory = (pi) => {
  // Restore the native prompt after other extensions have processed the hook.
  registerPromptPolicy(pi, spec.runtime.promptPolicy, () => nativeSystemPrompt);

  pi.on("session_start", (_event, ctx) => { bridgeContext = ctx; });
  pi.registerCommand("or", {
    description: "Return the pending child result to the parent",
    handler: async (_args, ctx) => { await returnPending("human_return", ctx); },
  });
  // Human steering detection and implicit continuation after Escape.
  pi.on("input", (event) => {
    const text = typeof event?.text === "string" ? event.text : "";
    if (pendingDecision && !decisionGateActive && event?.source === "interactive" && text.trim() && text.trim() !== "/or") {
      clearPendingForContinuation();
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
let decisionReturned = false;
let originalTools = session.getActiveToolNames();
const pendingDecisionPath = join(spec.bridge.mailboxDir, "pending-decision.json");
const releasedDecisionPath = join(spec.bridge.mailboxDir, "released-decision.json");
try { pendingDecision = JSON.parse(readFileSync(pendingDecisionPath, "utf-8")); } catch {}
if (pendingDecision?.runNumber) {
  runNumber = pendingDecision.runNumber;
  currentMaxTurns = pendingDecision.maxTurns;
}

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

function clearPendingForContinuation() {
  pendingDecision = null;
  decisionReturned = false;
  ceilingTriggered = false;
  reconciliationRun = false;
  parentAborted = false;
  try { rmSync(pendingDecisionPath, { force: true }); } catch {}
  try { rmSync(releasedDecisionPath, { force: true }); } catch {}
  try { session.setActiveToolsByName(originalTools); } catch {}
}

async function returnPending(releaseReason, ctx = bridgeContext) {
  if (inRun || session.isStreaming) {
    ctx?.ui?.notify?.("Wait for the current response before returning.", "warning");
    return false;
  }
  if (!pendingDecision || decisionReturned) {
    ctx?.ui?.notify?.(decisionReturned ? "This result was already returned to the parent." : "No child result is waiting to be returned.", "info");
    return false;
  }
  const decision = pendingDecision;
  const status = decision.reason === "aborted" ? "stopped" : "completed";
  try {
    // Persist before emitting: a resumed parent can distinguish an already
    // returned child from one that is still active.
    writeJsonAtomic(releasedDecisionPath, { ...decision, status, releasedAt: Date.now() });
    emitEvent(spec.bridge.mailboxDir, {
      type: "run_settled", runNumber: decision.runNumber, status,
      result: decision.result, turnCount: decision.turnCount, toolUses: decision.toolUses,
      compactions: decision.compactions, usage: decision.usage,
      releaseReason, decisionReason: decision.reason,
    });
  } catch (err) {
    ctx?.ui?.notify?.(`Could not return the child result: ${err?.message ?? err}`, "error");
    return false;
  }
  decisionReturned = true;
  pendingDecision = null;
  try { rmSync(pendingDecisionPath, { force: true }); } catch {}
  ctx?.ui?.notify?.("Child result returned to the parent.", "info");
  return true;
}

async function waitForBridgeContext() {
  for (let attempt = 0; attempt < 100 && !bridgeContext; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return bridgeContext;
}

async function showDecisionGate(decision) {
  if (decisionGateActive || decisionReturned || !decision) return;
  decisionGateActive = true;
  pendingDecision = decision;
  try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
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
      await returnPending("human_return");
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
      await session.prompt(continuationPrompt);
    } catch (err) {
      bridgeContext?.ui?.notify?.(`Could not continue the agent: ${err?.message ?? err}`, "warning");
      await showDecisionGate(decision);
    }
  }
}

async function requestReconciliation(s) {
  reconciliationRun = true;
  try {
    await s.prompt("The work-turn limit has been reached. Do not continue executing the task. Report current status for the human: work completed, remaining work, blockers, and the next action you would take.");
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
          if (!reconciliationRun) {
            runNumber++;
            turnCount = 0;
            toolUses = 0;
            parentAborted = false;
            emitEvent(spec.bridge.mailboxDir, { type: "run_started", runNumber, maxTurns: currentMaxTurns });
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
          void showDecisionGate({ runNumber, reason: "turn_limit", result: result || "No status response was produced. Review the session before deciding.", turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) });
          break;
        }
        if (ceilingTriggered) {
          void requestReconciliation(s);
          break;
        }
        if (status === "completed") {
          void showDecisionGate({ runNumber, reason: "completed", result: result || undefined, turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) });
        } else if (status === "stopped") {
          // Escape/abort never releases to the parent. Keep partial output
          // durable so /or can explicitly return it later.
          const decision = { runNumber, reason: "aborted", result: result || undefined, turnCount, maxTurns: currentMaxTurns, toolUses, requestedAt: Date.now(), compactions, usage: usageOf(s) };
          pendingDecision = decision;
          try { writeJsonAtomic(pendingDecisionPath, decision); } catch {}
          emitEvent(spec.bridge.mailboxDir, { type: "decision_required", ...decision });
          bridgeContext?.ui?.notify?.("Agent stopped. Nothing was returned to the parent. Use /or to return the partial result, or enter a prompt to continue.", "info");
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
          currentMaxTurns = cmd.maxTurns;
          clearPendingForContinuation();
          if (session.isStreaming) await session.followUp(cmd.message);
          else await session.prompt(cmd.message);
          break;
        case "abort":
          parentAborted = true;
          await session.abort();
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
}

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
    if (pendingDecision.reason === "aborted") {
      bridgeContext?.ui?.notify?.("Agent stopped. Nothing was returned to the parent. Use /or to return the partial result, or enter a prompt to continue.", "info");
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
