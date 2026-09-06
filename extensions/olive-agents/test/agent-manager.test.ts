/**
 * agent-manager.test.ts — Event-driven coordination of child agent Pi sessions
 * in tmux windows. The manager's side effects (tmux exec, launch preparation,
 * child command) are injected; mailbox events are driven through the real
 * filesystem mailbox.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, defaultChildCommand, resolveNodeExecutable, type SpawnOptions } from "../src/agent-manager.js";
import { emitChildEvent, ensureMailboxDir, readPendingCommands, removeMailboxDir, writePendingDecision } from "../src/event-mailbox.js";
import { agentWindowName } from "../src/names.js";
import type { ContextLinkData } from "../src/context-ledger.js";
import type { AgentLaunchSpec } from "../src/types.js";

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "olive-mgr-test-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const CANNED_SPEC: AgentLaunchSpec = {
  version: 2,
  agent: { id: "x", type: "Review", displayName: "Review", description: "review auth" },
  session: { id: "child-session-id", name: "Agent · Review · review auth · xxxxxxxx", sessionDir: work },
  runtime: {
    cwd: work,
    packageDir: "/pkg",
    model: { provider: "test", id: "basic" },
    thinking: "high",
    tools: ["read", "bash"],
    extensionPaths: [],
    systemPrompt: "system",
  },
  run: { prompt: "do it", maxTurns: 10, graceTurns: 5 },
  bridge: { mailboxDir: "" },
};

function makeDeps(options: { focusedWindow?: string } = {}) {
  let windowSeq = 0;
  const focused = options.focusedWindow ?? "@parent";
  const tmux = vi.fn(async (args: string[]) => {
    const key = args.join(" ");
    if (key === "display-message -p #{session_id}") return { code: 0, stdout: "$0", stderr: "", killed: false };
    if (key === "display-message -p #{window_id}") return { code: 0, stdout: focused, stderr: "", killed: false };
    if (key.startsWith("new-window ")) {
      windowSeq++;
      return { code: 0, stdout: `@${windowSeq} ${windowSeq + 1}\n`, stderr: "", killed: false };
    }
    if (key.startsWith("select-window ")) return { code: 0, stdout: "", stderr: "", killed: false };
    if (key.startsWith("display-message -p -t ")) {
      const wid = key.split(" ")[3];
      return { code: 0, stdout: wid ?? "@live", stderr: "", killed: false };
    }
    if (key.startsWith("set-window-option ")) return { code: 0, stdout: "", stderr: "", killed: false };
    if (key.startsWith("kill-window ")) return { code: 0, stdout: "", stderr: "", killed: false };
    return { code: 1, stdout: "", stderr: `unmocked ${key}`, killed: false };
  });
  const prepare = vi.fn(async (input: any) => {
    const spec = {
      ...CANNED_SPEC,
      bridge: { mailboxDir: input.mailboxDir },
      session: { ...CANNED_SPEC.session, parentFile: input.parentSessionFile },
      runtime: {
        ...CANNED_SPEC.runtime,
        cwd: input.ctx.cwd,
      },
    };
    return { spec, warnings: [] };
  });
  const childCommand = vi.fn((specPath: string) => `node child.mjs ${specPath}`);
  return { tmux, prepare, childCommand };
}

function makeCtx() {
  return {
    mode: "tui",
    hasUI: true,
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    cwd: work,
    model: { provider: "test", id: "basic", name: "Basic", reasoning: false },
    modelRegistry: { getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(work, "parent.jsonl"),
      getSessionDir: () => work,
      getBranch: () => [],
    },
    getSystemPrompt: () => "parent",
  } as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function spawnBg(manager: AgentManager, ctx: any, description = "review auth", opts: Partial<SpawnOptions> = {}) {
  return manager.spawn({ exec: vi.fn() } as any, ctx, "Review", "task", {
    description,
    maxTurns: 10,
    model: ctx.model,
    ...opts,
  });
}

describe("child host command", () => {
  it("uses Node when Pi is the standalone process executable", () => {
    expect(resolveNodeExecutable("/opt/pi/pi")).toBe("node");
    expect(defaultChildCommand("/tmp/olive-agents/launch.json", "/opt/pi/pi")).toMatch(/^'node' /);
  });

  it.each(["/usr/bin/node", "/usr/local/bin/nodejs", "C:\\\\Node\\\\node.exe"])(
    "preserves a Node executable: %s",
    (execPath) => expect(resolveNodeExecutable(execPath)).toBe(execPath),
  );
});

describe("AgentManager", () => {
  it("spawn → ready → run_settled completes the record and releases the slot", async () => {
    const deps = makeDeps();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 2, undefined, undefined, deps);
    const ctx = makeCtx();

    const id = await spawnBg(manager, ctx);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("queued");
    expect(deps.tmux).toHaveBeenCalled();

    // Child reports ready.
    emitChildEvent(record.mailboxDir!, { type: "ready", sessionId: "child-session-id", sessionFile: join(work, "child.jsonl") });
    await sleep(250);
    expect(manager.getRecord(id)!.status).toBe("running");
    expect(manager.getRecord(id)!.window?.state).toBe("alive");

    // Run settles.
    emitChildEvent(record.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 3, toolUses: 4 });
    await sleep(250);
    const settled = manager.getRecord(id)!;
    expect(settled.status).toBe("completed");
    expect(settled.result).toBe("done");
    expect(settled.toolUses).toBe(4);
    expect(settled.turnCount).toBe(3);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(manager.hasRunning()).toBe(false);
    manager.dispose();
  });

  it("accepts an unlimited run and its response-ready decision", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await manager.spawn({ exec: vi.fn() } as any, ctx, "Review", "task", {
      description: "unlimited",
      model: ctx.model,
      });
    const record = manager.getRecord(id)!;
    expect(deps.prepare.mock.calls[0]![0].options.maxTurns).toBeUndefined();
    emitChildEvent(record.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "unlimited.jsonl") });
    await sleep(150);
    emitChildEvent(record.mailboxDir!, {
      type: "decision_required", runNumber: 1, reason: "completed", result: "done",
      turnCount: 3, toolUses: 2, requestedAt: Date.now(),
    });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("awaiting_decision");
    manager.dispose();
  });

  it("concurrency limit queues background launches until a slot frees", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();

    const id1 = await spawnBg(manager, ctx, "one");
    const id2 = await spawnBg(manager, ctx, "two");

    expect(manager.getRecord(id1)!.status).toBe("queued");
    expect(manager.getRecord(id2)!.status).toBe("queued");
    expect(manager.getRecord(id2)!.window).toBeUndefined();

    // First run settles → second launch starts.
    emitChildEvent(manager.getRecord(id1)!.mailboxDir!, { type: "ready", sessionId: "s1", sessionFile: join(work, "1.jsonl") });
    await sleep(200);
    emitChildEvent(manager.getRecord(id1)!.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "r1", turnCount: 1, toolUses: 1 });
    await sleep(300);
    expect(manager.getRecord(id2)!.window).toBeDefined();
    expect(deps.prepare).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("marks a human-controlled settled run idle without returning model context", async () => {
    const deps = makeDeps();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 1, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "interactive");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "run_started", runNumber: 1, maxTurns: 10, mode: "automatic" });
    emitChildEvent(rec.mailboxDir!, { type: "run_idle", runNumber: 1, reason: "interrupted", turnCount: 1, toolUses: 0 });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("idle");
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(manager.hasRunning()).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("accepts repeatable context checkpoints, releases the work slot, and acknowledges them", async () => {
    const deps = makeDeps();
    const onCheckpoint = vi.fn();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    manager.setCallbacks({ onContextCheckpoint: onCheckpoint });
    const id = await spawnBg(manager, makeCtx(), "checkpoint");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, {
      type: "context_checkpoint",
      runNumber: 1,
      checkpoint: {
        version: 1,
        id: "cp-1",
        agentId: id,
        sourceSessionName: "child",
        createdAt: new Date().toISOString(),
        reason: "completed",
        selections: [{ kind: "message", entryId: "m1", role: "assistant", label: "assistant · done", text: "done" }],
        coveredEntryIds: ["m1"],
      },
    });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("idle");
    expect(manager.getRecord(id)?.result).toContain("done");
    expect(manager.hasRunning()).toBe(false);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(manager.acknowledgeCheckpoint(id, "cp-1")).toBe(true);
    expect(readPendingCommands(rec.mailboxDir!)).toContainEqual({ type: "ack_checkpoint", checkpointId: "cp-1" });
    manager.dispose();
  });

  it("defers returned checkpoints until their owning parent session is active", async () => {
    const deps = makeDeps();
    const onCheckpoint = vi.fn();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    manager.setCallbacks({ onContextCheckpoint: onCheckpoint });
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx, "session-owned");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "child.jsonl") });
    await sleep(100);
    manager.setParentSessionFile(join(work, "other-parent.jsonl"));
    emitChildEvent(rec.mailboxDir!, {
      type: "context_checkpoint", runNumber: 1,
      checkpoint: { version: 1, id: "cp-other", agentId: id, sourceSessionName: "child", createdAt: new Date().toISOString(), reason: "manual", selections: [], coveredEntryIds: [] },
    });
    await sleep(150);
    expect(onCheckpoint).not.toHaveBeenCalled();
    manager.setParentSessionFile(join(work, "parent.jsonl"));
    await sleep(50);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint.mock.calls[0]![1].id).toBe("cp-other");
    manager.dispose();
  });

  it("child process death releases nothing and remains reopenable", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "dies");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "run_started", runNumber: 1, maxTurns: 10 });
    emitChildEvent(rec.mailboxDir!, { type: "process_exit" });
    await sleep(200);
    expect(manager.getRecord(id)?.status).toBe("running");
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(manager.hasRunning()).toBe(true);
    expect(manager.getRecord(id)?.window?.state).toBe("closed");
    manager.dispose();
  });

  it("dispose detaches without stopping a launched child", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx());
    const mailboxDir = manager.getRecord(id)!.mailboxDir!;

    manager.dispose();

    expect(readPendingCommands(mailboxDir)).toEqual([]);
    expect(deps.tmux).not.toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    removeMailboxDir(mailboxDir);
  });

  it("process_exit marks the window closed", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "process_exit" });
    await sleep(250);
    expect(manager.getRecord(id)!.window?.state).toBe("closed");
    manager.dispose();
  });

  it("prepare failure rejects the spawn", async () => {
    const deps = makeDeps();
    deps.prepare.mockRejectedValue(new Error("no tmux here"));
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();
    await expect(spawnBg(manager, ctx, "one")).rejects.toThrow("no tmux here");
    expect(manager.listAgents()).toHaveLength(0);
    manager.dispose();
  });

  it("clear keeps the child Pi session file (record only is removed)", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "child.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "x", turnCount: 1, toolUses: 1 });
    await sleep(250);
    expect(manager.removeTerminal(id)).toBe(true);
    expect(manager.getRecord(id)).toBeUndefined();
    manager.dispose();
  });

  it("focusOrReopen focuses an alive window and refuses queued records", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    expect(await manager.focusOrReopen(id)).toBe(true);
    expect(deps.tmux).toHaveBeenCalledWith(expect.arrayContaining(["select-window"]));
    manager.dispose();
  });

  it("settle leaves the completed window open (no auto-close)", async () => {
    const deps = makeDeps(); // focused window is "@parent", never the agent's
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    expect(manager.getRecord(id)!.window?.state).toBe("alive");
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    await sleep(300);
    const settled = manager.getRecord(id)!;
    expect(settled.status).toBe("completed");
    expect(settled.result).toBe("done");
    expect(settled.window?.state).toBe("alive");
    // Completion must never issue a window close.
    expect(deps.tmux).not.toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    // Not consumed yet — the record stays for review.
    expect(manager.getRecord(id)).toBeDefined();
    manager.dispose();
  });

  it("settle keeps the window open while the user is viewing it", async () => {
    const deps = makeDeps({ focusedWindow: "@1" }); // will match the agent window id
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    await sleep(300);
    expect(manager.getRecord(id)!.window?.state).toBe("alive");
    expect(deps.tmux).not.toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    manager.dispose();
  });

  it("dismiss closes an idle child window (settled but durable)", async () => {
    const deps = makeDeps({ focusedWindow: "@1" }); // window stays open after run_idle
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "idle child");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_idle", runNumber: 1, reason: "completed", turnCount: 2, toolUses: 1 });
    await sleep(300);
    expect(manager.getRecord(id)!.status).toBe("idle");
    expect(await manager.dismiss(id)).toBe("dismissed");
    expect(manager.getRecord(id)).toBeUndefined();
    expect(deps.tmux).toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    manager.dispose();
  });

  it("dismiss closes an open window and forgets the record", async () => {
    const deps = makeDeps({ focusedWindow: "@1" }); // window stays open after settle
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    await sleep(300);
    expect(manager.getRecord(id)!.window?.state).toBe("alive");
    expect(await manager.dismiss(id)).toBe("dismissed");
    expect(manager.getRecord(id)).toBeUndefined();
    expect(deps.tmux).toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    manager.dispose();
  });

  it("dismiss reports failure and retains the row when tmux refuses the kill", async () => {
    const deps = makeDeps({ focusedWindow: "@1" });
    const base = deps.tmux;
    deps.tmux = vi.fn(async (args: string[]) => {
      if (args[0] === "kill-window") return { code: 1, stdout: "", stderr: "window busy", killed: false };
      return base(args);
    });
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    await sleep(300);
    expect(await manager.dismiss(id)).toBe("failed");
    expect(manager.getRecord(id)).toBeDefined();
    expect(manager.getRecord(id)!.window?.state).toBe("alive");
    manager.dispose();
  });

  it("/ocl forceClear releases the slot, keeps the mailbox with a released marker, and starts queued work", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();

    const id1 = await spawnBg(manager, ctx, "zombie-one");   // starts (slot taken)
    const id2 = await spawnBg(manager, ctx, "queued-two");   // queued behind the slot
    expect(manager.getRecord(id2)!.status).toBe("queued");

    const mail1 = manager.getRecord(id1)!.mailboxDir!;
    expect(await manager.forceClear(id1)).toBe("cleared");
    expect(manager.getRecord(id1)).toBeUndefined();
    // Mailbox kept (for /ot metadata) but marked released so restores skip it.
    expect(existsSync(mail1)).toBe(true);
    expect(existsSync(join(mail1, "released-decision.json"))).toBe(true);
    // tmux window was killed.
    expect(deps.tmux.mock.calls.some((call) => String(call[0][0]) === "kill-window")).toBe(true);
    // Slot released -> the queued agent starts (gets a window) once drainQueue runs.
    await sleep(300);
    expect(manager.getRecord(id2)!.window).toBeDefined();

    const mail2 = manager.getRecord(id2)!.mailboxDir!;
    expect(await manager.forceClear(id2)).toBe("cleared");
    expect(manager.getRecord(id2)).toBeUndefined();
    expect(existsSync(join(mail2, "released-decision.json"))).toBe(true);
    expect(manager.listAgents()).toHaveLength(0);
    manager.dispose();
  });

  it("/ocl forceClear drops a queued record without creating a window or mailbox", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();

    const id1 = await spawnBg(manager, ctx, "slot-holder"); // takes the only slot
    const id2 = await spawnBg(manager, ctx, "queued-drop"); // never started
    const mail2 = manager.getRecord(id2)!.mailboxDir;
    expect(mail2).toBeUndefined();

    expect(await manager.forceClear(id2)).toBe("cleared");
    expect(manager.getRecord(id2)).toBeUndefined();
    expect(manager.getRecord(id1)).toBeDefined();
    manager.dispose();
  });

  it("restores a pending decision after the parent session reopens", async () => {
    const deps = makeDeps();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 1, undefined, undefined, deps);
    const mailboxDir = join(work, "retained-mailbox");
    const childFile = join(work, "child.jsonl");
    writeFileSync(childFile, "");
    ensureMailboxDir(mailboxDir);
    writePendingDecision(mailboxDir, { runNumber: 2, reason: "turn_limit", result: "held", turnCount: 3, maxTurns: 3, toolUses: 1, requestedAt: Date.now() });
    const link: ContextLinkData = {
      version: 1, stage: "ready", agentId: "restored-agent", agentType: "Review", description: "restored",
      childSessionId: "child-id", childSessionName: "child", childSessionFile: childFile,
      createdAt: new Date().toISOString(), mailboxDir,
      reopen: {
        type: "Review", description: "restored", cwd: work, model: { provider: "test", id: "basic" },
        tools: ["read"], extensionPaths: [], maxTurns: 3,
      },
    };
    expect(await manager.restoreFromPersisted(link)).toBe(true);
    expect(manager.getRecord(link.agentId)?.status).toBe("awaiting_decision");
    expect(manager.getRecord(link.agentId)?.decision?.result).toBe("held");
    emitChildEvent(mailboxDir, { type: "run_settled", runNumber: 2, status: "completed", result: "held", turnCount: 3, toolUses: 1, releaseReason: "human_return", decisionReason: "turn_limit" });
    await sleep(200);
    expect(manager.getRecord(link.agentId)?.status).toBe("completed");
    expect(onComplete).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("/ot reopen registers a managed record and delivers checkpoints from the reopen mailbox", async () => {
    const deps = makeDeps();
    const onCheckpoint = vi.fn();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    manager.setCallbacks({ onContextCheckpoint: onCheckpoint });
    const childFile = join(work, "child.jsonl");
    writeFileSync(childFile, "");
    const link: ContextLinkData = {
      version: 1, stage: "ready", agentId: "reopen-agent", agentType: "Review", description: "reopened",
      childSessionId: "child-id", childSessionName: "child", childSessionFile: childFile,
      createdAt: new Date().toISOString(), mailboxDir: join(work, "original-mailbox"),
      reopen: {
        type: "Review", description: "reopened", cwd: work, model: { provider: "test", id: "basic" },
        tools: ["read"], extensionPaths: [], maxTurns: 10,
      },
    };
    const result = await manager.reopenFromPersisted(link);
    expect(result.ok).toBe(true);
    const record = manager.getRecord("reopen-agent")!;
    expect(record.mailboxDir).toContain("reopen");

    // The child boots: ready, then reports its idle boot state.
    emitChildEvent(record.mailboxDir!, { type: "ready", sessionId: "child-id", sessionFile: childFile });
    const bootState = join(record.mailboxDir!, "bridge-state.json");
    writeFileSync(bootState, JSON.stringify({ version: 1, status: "idle", mode: "interactive", updatedAt: Date.now() }));
    emitChildEvent(record.mailboxDir!, { type: "run_idle", runNumber: 0, reason: "interrupted", turnCount: 0, toolUses: 0 });
    await sleep(150);
    expect(manager.getRecord("reopen-agent")?.status).toBe("idle");

    // A checkpoint emitted into the reopen mailbox must reach the parent.
    emitChildEvent(record.mailboxDir!, {
      type: "context_checkpoint", runNumber: 1,
      checkpoint: { version: 1, id: "cp-reopen", agentId: "reopen-agent", sourceSessionName: "child", createdAt: new Date().toISOString(), reason: "manual", selections: [], coveredEntryIds: ["m1"] },
    });
    await sleep(150);
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint.mock.calls[0]![1].id).toBe("cp-reopen");
    expect(manager.acknowledgeCheckpoint("reopen-agent", "cp-reopen")).toBe(true);
    expect(readPendingCommands(record.mailboxDir!)).toContainEqual({ type: "ack_checkpoint", checkpointId: "cp-reopen" });
    manager.dispose();
  });

  it("/ot reuses the original mailbox when focusing a live child", async () => {
    const deps = makeDeps();
    const base = deps.tmux;
    const originalMailbox = join(work, "original-mailbox");
    ensureMailboxDir(originalMailbox);
    writePendingDecision(originalMailbox, { runNumber: 2, reason: "turn_limit", result: "held", turnCount: 3, maxTurns: 3, toolUses: 1, requestedAt: Date.now() });
    writeFileSync(join(originalMailbox, "bridge-state.json"), JSON.stringify({ status: "awaiting_decision" }));
    deps.tmux = vi.fn(async (args: string[]) => {
      if (args[0] === "list-windows") return { code: 0, stdout: `@9\t9\t${agentWindowName("live child")}\n`, stderr: "", killed: false };
      return base(args);
    });
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const childFile = join(work, "child-live.jsonl");
    writeFileSync(childFile, "");
    const link: ContextLinkData = {
      version: 1, stage: "ready", agentId: "reopen-live", agentType: "Review", description: "live child",
      childSessionId: "child-id", childSessionName: "child", childSessionFile: childFile,
      createdAt: new Date().toISOString(), mailboxDir: originalMailbox,
      reopen: { type: "Review", description: "live child", cwd: work, model: { provider: "test", id: "basic" }, tools: ["read"], extensionPaths: [], maxTurns: 3 },
    };
    const result = await manager.reopenFromPersisted(link);
    expect(result).toMatchObject({ ok: true, focused: true });
    expect(manager.getRecord("reopen-live")?.mailboxDir).toBe(originalMailbox);
    expect(manager.getRecord("reopen-live")?.status).toBe("awaiting_decision");
    expect(manager.getRecord("reopen-live")?.decision?.result).toBe("held");
    manager.dispose();
  });

  it("decision_required keeps the slot and foreground waiter pending until release", async () => {
    const deps = makeDeps();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 1, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await manager.spawn({ exec: vi.fn() } as any, ctx, "Review", "task", { description: "decision", model: ctx.model, maxTurns: 3 });
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "run_started", runNumber: 1, maxTurns: 3 });
    emitChildEvent(rec.mailboxDir!, { type: "decision_required", runNumber: 1, reason: "completed", result: "pending", turnCount: 2, maxTurns: 3, toolUses: 0, requestedAt: Date.now() });
    await sleep(200);
    expect(manager.getRecord(id)?.status).toBe("awaiting_decision");
    expect(manager.hasRunning()).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
    emitChildEvent(rec.mailboxDir!, { type: "decision_required", runNumber: 1, reason: "completed", result: "duplicate", turnCount: 2, maxTurns: 3, toolUses: 0, requestedAt: Date.now() });
    await sleep(150);
    expect(manager.getRecord(id)?.decision?.result).toBe("pending");
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "pending", turnCount: 2, toolUses: 0, releaseReason: "human_return", decisionReason: "completed" });
    await sleep(200);
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.hasRunning()).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("error settlement releases the slot without returning context", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "error child");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "error", error: "provider failed", turnCount: 1, toolUses: 0, releaseReason: "error" });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("error");
    expect(manager.getRecord(id)?.result).toBeUndefined();
    expect(manager.hasRunning()).toBe(false);
    manager.dispose();
  });

  it("run_idle after a decision clears the gate and allows dismissal", async () => {
    const deps = makeDeps({ focusedWindow: "@1" });
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "interrupted decision");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "run_started", runNumber: 1, maxTurns: 10 });
    emitChildEvent(rec.mailboxDir!, { type: "decision_required", runNumber: 1, reason: "completed", result: "held", turnCount: 1, maxTurns: 10, toolUses: 0, requestedAt: Date.now() });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("awaiting_decision");
    emitChildEvent(rec.mailboxDir!, { type: "run_idle", runNumber: 1, reason: "interrupted", turnCount: 1, toolUses: 0 });
    await sleep(150);
    expect(manager.getRecord(id)?.status).toBe("idle");
    expect(manager.getRecord(id)?.decision).toBeUndefined();
    expect(manager.hasRunning()).toBe(false);
    expect(await manager.dismiss(id)).toBe("dismissed");
    expect(manager.getRecord(id)).toBeUndefined();
    manager.dispose();
  });

  it("dismiss refuses running agents", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    expect(await manager.dismiss(id)).toBe("active");
    expect(manager.getRecord(id)).toBeDefined();
    expect(deps.tmux).not.toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
    manager.dispose();
  });
});

function readCommands(mailboxDir: string): any[] {
  const dir = join(mailboxDir, "commands");
  try {
    return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
  } catch {
    return [];
  }
}
