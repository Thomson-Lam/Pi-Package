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

const { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, getAgentDir, ModelRuntime, InteractiveMode } =
  await import(pathToFileURL(join(spec.runtime.packageDir, "dist", "index.js")));

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

const bridgeFactory = (pi) => {
  // Human steering detection: interactive input while the agent is streaming.
  pi.on("input", (event) => {
    if (event?.source === "interactive" && event.streamingBehavior) {
      const text = typeof event.text === "string" ? event.text : "";
      if (text.trim()) emitEvent(spec.bridge.mailboxDir, { type: "human_steer", text: text.slice(0, 500) });
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
            extensions: base.extensions.filter((extension) => spec.runtime.extensionPaths.includes(extension.path)),
          }),
      noSkills: spec.runtime.noSkills,
      noPromptTemplates: true,
      noThemes: false,
      noContextFiles: true,
      systemPromptOverride: () => spec.runtime.systemPrompt,
      appendSystemPromptOverride: () => [],
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
let softLimitReached = false;
let limitAborted = false;
let parentAborted = false;
let compactions = 0;

const maxTurns = spec.run.maxTurns;
const graceTurns = spec.run.graceTurns;

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
  if (limitAborted) return "aborted";
  const last = lastAssistant(session);
  if (last?.stopReason === "error") return "error";
  if (last?.stopReason === "aborted") return "stopped"; // human escape
  return softLimitReached ? "steered" : "completed";
}

function subscribeTo(s) {
  return s.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        if (!inRun) {
          inRun = true;
          runNumber++;
          turnCount = 0;
          toolUses = 0;
          softLimitReached = false;
          limitAborted = false;
          parentAborted = false;
          emitEvent(spec.bridge.mailboxDir, { type: "run_started", runNumber });
        }
        break;

      case "turn_end": {
        turnCount = event.turnIndex != null ? event.turnIndex + 1 : turnCount + 1;
        emitEvent(spec.bridge.mailboxDir, { type: "turn_finished", turnCount });
        // Turn-limit enforcement (mirrors the old in-process runner).
        if (maxTurns != null) {
          if (!softLimitReached && turnCount >= maxTurns) {
            softLimitReached = true;
            s.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.")
              .catch(() => {});
          } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
            limitAborted = true;
            s.abort();
          }
        }
        break;
      }

      case "tool_execution_start":
        emitEvent(spec.bridge.mailboxDir, {
          type: "tool_started",
          toolName: event.toolName,
          target: targetOf(event.args),
        });
        break;

      case "tool_execution_end":
        toolUses++;
        emitEvent(spec.bridge.mailboxDir, { type: "tool_finished", toolName: event.toolName });
        break;

      case "compaction_end":
        if (!event.aborted && event.result) compactions++;
        break;

      case "agent_settled": {
        if (!inRun) break;
        inRun = false;
        const status = settledStatus();
        const last = lastAssistant(session);
        const result = assistantText(last);
        const error =
          status === "error"
            ? (last?.errorMessage?.trim?.() || "provider error with no output")
            : status === "stopped"
              ? "stopped by the user"
              : status === "aborted"
                ? "hit the turn limit before completion"
                : undefined;
        let usage;
        try {
          const stats = s.getSessionStats?.();
          const t = stats?.tokens;
          if (t) usage = { input: t.input ?? 0, output: t.output ?? 0, cacheWrite: t.cacheWrite ?? 0 };
        } catch { /* stats are best effort */ }
        emitEvent(spec.bridge.mailboxDir, {
          type: "run_settled",
          runNumber,
          status,
          result: result || undefined,
          error,
          turnCount,
          toolUses,
          compactions,
          usage,
        });
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

const mode = new InteractiveMode(runtime, {
  initialMessage: spec.run.prompt || undefined,
  verbose: false,
});

try {
  await mode.run();
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
  });
} finally {
  clearInterval(commandTimer);
  unsubscribe();
  if (!shuttingDown) emitEvent(spec.bridge.mailboxDir, { type: "process_exit" });
  try { await runtime.dispose(); } catch {}
  process.exit(0);
}
