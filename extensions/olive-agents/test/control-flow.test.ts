import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { emitChildEvent, readPendingCommands } from "../src/event-mailbox.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const log: string[] = [];
  const model = { provider: "test", id: "basic", name: "Basic", reasoning: false };
  const pi: any = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn((type: string) => log.push(`append:${type}`)),
    sendMessage: vi.fn(() => log.push("send:checkpoint")),
    sendUserMessage: vi.fn((text: string) => log.push(`send:user:${text}`)),
    getThinkingLevel: vi.fn(() => "off"),
    getActiveTools: vi.fn(() => ["read"]),
    getAllTools: vi.fn(() => [{ name: "read", sourceInfo: { path: "/tmp/read.js" } }]),
    exec: vi.fn(async (program: string, args: string[]) => {
      if (program === "git") return { code: 1, stdout: "", stderr: "", killed: false };
      if (args[0] === "display-message" && args.includes("#{session_id}")) return { code: 0, stdout: "$0\n", stderr: "", killed: false };
      if (args[0] === "list-windows") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "new-window") return { code: 0, stdout: "@1 1\n", stderr: "", killed: false };
      if (args[0] === "display-message") return { code: 0, stdout: "@1\n", stderr: "", killed: false };
      if (args[0] === "select-window" || args[0] === "kill-window") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "unmocked", killed: false };
    }),
  };
  return { pi, tools, handlers, log, model };
}

function makeContext(model: any, cwd: string) {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    model,
    modelRegistry: { getAvailable: () => [model], getAll: () => [model] },
    ui: {
      select: vi.fn(async () => "Launch"),
      notify: vi.fn(),
      input: vi.fn(),
      editor: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "parent",
      getSessionFile: () => join(cwd, "parent.jsonl"),
      getSessionDir: () => cwd,
      getBranch: () => [],
      getEntries: () => [],
    },
  } as any;
}

describe("olive-agents supervised control flow", () => {
  let cwd: string;
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("registers only Agent, omits retired parameters, detaches successful launches, and keeps completion/error/steering local", async () => {
    cwd = mkdtempSync(join(tmpdir(), "olive-control-"));
    const { pi, tools, handlers, model } = makePi();
    subagentsExtension(pi);
    shutdown = async () => { await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} }); };

    expect([...tools.keys()]).toEqual(["Agent"]);
    const agent = tools.get("Agent");
    expect(agent.parameters.properties.run_in_background).toBeUndefined();
    expect(agent.parameters.properties.resume).toBeUndefined();

    const result = await agent.execute("call-1", {
      prompt: "inspect the project",
      description: "Inspect project",
      subagent_type: "general-purpose",
      max_turns: 3,
    }, new AbortController().signal, undefined, makeContext(model, cwd));
    expect(result.terminate).toBe(true);
    expect(result.details.status).toBe("detached");
    expect(pi.sendMessage).not.toHaveBeenCalled();

    const newWindow = pi.exec.mock.calls.find((call: any[]) => call[0] === "tmux" && call[1]?.[0] === "new-window");
    const specPath = newWindow?.[1].at(-1).match(/'([^']*launch\.json)'/)?.[1];
    expect(specPath).toBeTruthy();
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const mailbox = spec.bridge.mailboxDir;

    emitChildEvent(mailbox, { type: "ready", sessionId: "child", sessionFile: join(cwd, "child.jsonl") });
    emitChildEvent(mailbox, { type: "run_settled", runNumber: 1, status: "completed", result: "done", turnCount: 1, toolUses: 1 });
    emitChildEvent(mailbox, { type: "human_steer", runNumber: 1, text: "child-local" } as any);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("inserts a returned checkpoint before receipt/ack, deduplicates it, preserves note order, and does not ack insertion failures", async () => {
    cwd = mkdtempSync(join(tmpdir(), "olive-checkpoint-"));
    const { pi, tools, handlers, model, log } = makePi();
    subagentsExtension(pi);
    shutdown = async () => { await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} }); };
    await tools.get("Agent").execute("call-1", { prompt: "task", description: "Do task", max_turns: 2 }, undefined, undefined, makeContext(model, cwd));
    const call = pi.exec.mock.calls.find((args: any[]) => args[0] === "tmux" && args[1]?.[0] === "new-window");
    const specPath = call?.[1].at(-1).match(/'([^']*launch\.json)'/)?.[1];
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const mailbox = spec.bridge.mailboxDir;
    emitChildEvent(mailbox, { type: "ready", sessionId: "child", sessionFile: join(cwd, "child.jsonl") });
    const checkpoint = {
      version: 1 as const, id: "cp-1", agentId: spec.agent.id, sourceSessionName: "child",
      createdAt: new Date().toISOString(), reason: "completed" as const,
      selections: [{ kind: "message" as const, entryId: "m1", role: "assistant" as const, label: "assistant", text: "done" }],
      coveredEntryIds: ["m1"], note: "Review this",
    };
    emitChildEvent(mailbox, { type: "context_checkpoint", runNumber: 1, checkpoint });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(log.indexOf("send:checkpoint")).toBeLessThan(log.indexOf("append:olive-agent-context-return-received"));
    expect(log.indexOf("append:olive-agent-context-return-received")).toBeLessThan(log.indexOf("send:user:Review this"));
    expect(readPendingCommands(mailbox)).toContainEqual({ type: "ack_checkpoint", checkpointId: "cp-1" });
    const count = pi.sendMessage.mock.calls.length;
    emitChildEvent(mailbox, { type: "context_checkpoint", runNumber: 1, checkpoint });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pi.sendMessage).toHaveBeenCalledTimes(count);

    pi.sendMessage.mockImplementationOnce(() => { throw new Error("parent insertion failed"); });
    const failed = { ...checkpoint, id: "cp-fail", note: undefined };
    emitChildEvent(mailbox, { type: "context_checkpoint", runNumber: 1, checkpoint: failed });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readPendingCommands(mailbox).some((command) => command.checkpointId === "cp-fail")).toBe(false);
    expect(pi.appendEntry.mock.calls.some((call: any[]) => call[0] === "olive-agent-context-return-received" && call[1]?.checkpointId === "cp-fail")).toBe(false);
    expect(existsSync(mailbox)).toBe(true);
  });
});
