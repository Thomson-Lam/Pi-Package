/**
 * agent-manager.test.ts — Event-driven coordination of child agent Pi sessions
 * in tmux windows. The manager's side effects (tmux exec, launch preparation,
 * child command) are injected; mailbox events are driven through the real
 * filesystem mailbox.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type SpawnOptions } from "../src/agent-manager.js";
import { emitChildEvent, ensureMailboxDir, readPendingCommands, removeMailboxDir, writePendingDecision } from "../src/event-mailbox.js";
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
    noExtensions: true,
    extensionPaths: [],
    noSkills: true,
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
      runtime: { ...CANNED_SPEC.runtime, cwd: input.ctx.cwd },
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
    isBackground: true,
    maxTurns: 10,
    model: ctx.model,
    ...opts,
  });
}

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

  it("foreground spawnAndWait returns the settled record", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();

    const wait = manager.spawnAndWait({ exec: vi.fn() } as any, ctx, "Review", "task", {
      description: "fg",
      model: ctx.model,
      maxTurns: 10,
    });
    await sleep(100);
    const record = manager.listAgents()[0]!;
    emitChildEvent(record.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(150);
    emitChildEvent(record.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "fg done", turnCount: 1, toolUses: 2 });
    const { record: done } = await wait;
    expect(done.result).toBe("fg done");
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

  it("abort on a queued agent stops it without a window", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();
    const id1 = await spawnBg(manager, ctx, "one");
    const id2 = await spawnBg(manager, ctx, "two");
    expect(manager.abort(id2)).toBe(true);
    expect(manager.getRecord(id2)!.status).toBe("stopped");
    manager.dispose();
  });

  it("abort keeps the foreground waiter pending until explicit /or release", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const ctx = makeCtx();
    let resolved = false;
    const wait = manager.spawnAndWait({ exec: vi.fn() } as any, ctx, "Review", "task", { description: "fg", model: ctx.model, maxTurns: 10 }).then((value) => { resolved = true; return value; });
    await sleep(100);
    const record = manager.listAgents()[0]!;
    emitChildEvent(record.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(record.mailboxDir!, { type: "run_started", runNumber: 1, maxTurns: 10 });
    await sleep(100);
    expect(manager.abort(record.id)).toBe(true);
    emitChildEvent(record.mailboxDir!, { type: "decision_required", runNumber: 1, reason: "aborted", result: "partial", turnCount: 1, maxTurns: 10, toolUses: 0, requestedAt: Date.now() });
    await sleep(150);
    expect(resolved).toBe(false);
    expect(manager.getRecord(record.id)?.status).toBe("awaiting_decision");
    emitChildEvent(record.mailboxDir!, { type: "run_settled", runNumber: 1, status: "stopped", result: "partial", turnCount: 1, toolUses: 0, releaseReason: "human_return", decisionReason: "aborted" });
    expect((await wait).record.result).toBe("partial");
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

  it("abort on a running agent writes an abort command", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    emitChildEvent(manager.getRecord(id)!.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("running");
    expect(manager.getRecord(id)!.stopReason).toBe("stop requested");
    manager.dispose();
  });

  it("human_steer events fire the onHumanSteer callback", async () => {
    const deps = makeDeps();
    const onSteer = vi.fn();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    manager.setCallbacks({ onHumanSteer: onSteer });
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "human_steer", text: "look at this" });
    await sleep(250);
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onSteer.mock.calls[0]![1]).toBe("look at this");
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

  it("consumeResult keeps the live window; manual close then clears the record", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 2, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await spawnBg(manager, ctx);
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s", sessionFile: join(work, "c.jsonl") });
    await sleep(200);
    emitChildEvent(rec.mailboxDir!, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    await sleep(300);
    // Consuming the result must NOT dismiss the still-open window.
    manager.consumeResult(id);
    expect(manager.getRecord(id)).toBeDefined();
    expect(manager.getRecord(id)!.window?.state).toBe("alive");
    // The human closes the window by exiting the child Pi session.
    emitChildEvent(rec.mailboxDir!, { type: "process_exit" });
    await sleep(250);
    expect(manager.getRecord(id)).toBeUndefined();
    expect(deps.tmux).not.toHaveBeenCalledWith(expect.arrayContaining(["kill-window"]));
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
      createdAt: new Date().toISOString(), mailboxDir, isBackground: false,
      reopen: { type: "Review", description: "restored", cwd: work, model: { provider: "test", id: "basic" }, tools: ["read"], noExtensions: true, extensionPaths: [], noSkills: true, maxTurns: 3 },
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

  it("decision_required keeps the slot and foreground waiter pending until release", async () => {
    const deps = makeDeps();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 1, undefined, undefined, deps);
    const ctx = makeCtx();
    const id = await manager.spawn({ exec: vi.fn() } as any, ctx, "Review", "task", { description: "decision", model: ctx.model, maxTurns: 3, isBackground: true });
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

  it("awaiting decision cannot be dismissed or released by abort", async () => {
    const deps = makeDeps();
    const manager = new AgentManager(undefined, 1, undefined, undefined, deps);
    const id = await spawnBg(manager, makeCtx(), "decision");
    const rec = manager.getRecord(id)!;
    emitChildEvent(rec.mailboxDir!, { type: "ready", sessionId: "s" });
    await sleep(100);
    emitChildEvent(rec.mailboxDir!, { type: "decision_required", runNumber: 1, reason: "turn_limit", result: "status", turnCount: 10, maxTurns: 10, toolUses: 1, requestedAt: Date.now() });
    await sleep(150);
    expect(await manager.dismiss(id)).toBe("active");
    expect(manager.abort(id)).toBe(true);
    expect(manager.getRecord(id)?.status).toBe("awaiting_decision");
    expect(manager.hasRunning()).toBe(true);
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
