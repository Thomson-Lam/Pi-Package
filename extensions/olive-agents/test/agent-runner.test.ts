/**
 * agent-runner.test.ts — Launch-spec preparation for child agent Pi sessions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  getToolNamesForType: vi.fn(),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  resolveType: vi.fn((t: string) => t),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Review"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Review"]),
  getDefaultAgentNames: vi.fn(() => ["general-purpose", "Review"]),
  getUserAgentNames: vi.fn(() => []),
  isValidType: vi.fn(() => true),
}));

import { getAgentConfig, getConfig, getToolNamesForType } from "../src/agent-types.js";
import { prepareAgentLaunch, setDefaultMaxTurns, setGraceTurns, SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import type { DeliveredContextHandoff } from "../src/handoff/serialize.js";
import type { AgentLaunchSpec } from "../src/types.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-runner-test-"));
  vi.mocked(getConfig).mockReturnValue({
    displayName: "Review",
    description: "Read-only code review agent",
    builtinToolNames: ["read", "bash", "grep", "find", "ls"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  } as any);
  vi.mocked(getAgentConfig).mockReturnValue({
    name: "Review",
    displayName: "Review",
    description: "Read-only code review agent",
    builtinToolNames: ["read", "bash", "grep", "find", "ls"],
    extensions: false,
    excludeExtensions: undefined,
    skills: false,
    disallowedTools: undefined,
    systemPrompt: "You are a reviewer.",
    promptMode: "replace",
    isDefault: true,
  } as any);
  vi.mocked(getToolNamesForType).mockReturnValue(["read", "bash", "grep", "find", "ls"]);
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function makePi() {
  return {
    exec: vi.fn(async (_cmd: string, _args: string[], _opts?: any) => ({ code: 1, stdout: "", stderr: "", killed: false })),
  } as any;
}

function makeCtx(overrides: any = {}) {
  return {
    cwd: work,
    model: { provider: "test", id: "basic", name: "Basic", reasoning: false },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(work, "parent.jsonl"),
      getSessionDir: () => work,
      getBranch: () => [],
    },
    getSystemPrompt: () => "parent system prompt",
    ...overrides,
  } as any;
}

const BASE_OPTIONS = {
  model: { provider: "test", id: "basic", name: "Basic", reasoning: false },
  thinking: "high",
  maxTurns: 10,
  isolated: false,
  inheritContext: false,
} as const;

async function prepare(overrides: any = {}, options: any = BASE_OPTIONS) {
  return prepareAgentLaunch({
    pi: makePi(),
    ctx: makeCtx(),
    type: "Review",
    prompt: "Review the diff",
    description: "review the diff",
    options,
    agentId: "a1b2c3d4e5f6g7h",
    childSessionId: "child-session-uuid",
    parentSessionFile: join(work, "parent.jsonl"),
    sessionDir: work,
    mailboxDir: join(work, "mailbox"),
    ...overrides,
  });
}

describe("prepareAgentLaunch", () => {
  it("produces a fully serializable spec", async () => {
    const { spec } = await prepare();
    expect(spec.version).toBe(2);
    expect(spec.agent).toMatchObject({ type: "Review", description: "review the diff" });
    expect(spec.runtime.model).toEqual({ provider: "test", id: "basic" });
    expect(spec.runtime.thinking).toBe("high");
    expect(spec.session).toMatchObject({
      id: "child-session-uuid",
      parentFile: join(work, "parent.jsonl"),
      sessionDir: work,
    });
    expect(spec.bridge.mailboxDir).toBe(join(work, "mailbox"));
    expect(spec.run.prompt).toContain("Review the diff");
    expect(spec.run.maxTurns).toBe(10);
    // No packet was approved — the spec must not carry one.
    expect(spec.run.handoff).toBeUndefined();
    // JSON-serializable, no functions, no secrets.
    const parsed = JSON.parse(JSON.stringify(spec)) as AgentLaunchSpec;
    expect(parsed.runtime.model.id).toBe("basic");
    expect(JSON.stringify(spec)).not.toContain("apiKey");
    expect(JSON.stringify(spec)).not.toContain("api_key");
  });

  it("never includes olive's own tools in the child allowlist", async () => {
    const { spec } = await prepare();
    for (const name of Object.values(SUBAGENT_TOOL_NAMES)) {
      expect(spec.runtime.tools).not.toContain(name);
    }
  });

  it("applies disallowed_tools", async () => {
    vi.mocked(getAgentConfig).mockReturnValue({
      ...(vi.mocked(getAgentConfig).mock.results[0]?.value ?? {}),
      disallowedTools: ["bash"],
      builtinToolNames: ["read", "bash", "grep", "find", "ls"],
    } as any);
    const { spec } = await prepare();
    expect(spec.runtime.tools).not.toContain("bash");
    expect(spec.runtime.tools).toContain("read");
  });

  it("prepends parent context when inherit_context is set", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: "earlier question" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }] } },
    ];
    const { spec } = await prepare(
      { ctx: makeCtx({ sessionManager: { getSessionId: () => "p", getSessionFile: () => join(work, "p.jsonl"), getSessionDir: () => work, getBranch: () => branch } }) },
      { ...BASE_OPTIONS, inheritContext: true },
    );
    expect(spec.run.prompt).toContain("earlier question");
    expect(spec.run.prompt).toContain("earlier answer");
    expect(spec.run.prompt).toContain("Review the diff");
  });

  it("does not inject parent context by default", async () => {
    const { spec } = await prepare();
    expect(spec.run.prompt).not.toContain("Parent Conversation Context");
  });

  it("normalizes max turns and applies grace turns", async () => {
    setDefaultMaxTurns(20);
    setGraceTurns(3);
    const { spec } = await prepare({}, { ...BASE_OPTIONS, maxTurns: undefined });
    expect(spec.run.maxTurns).toBe(20);
    expect(spec.run.graceTurns).toBe(3);
  });

  it("uses the worktree cwd when provided", async () => {
    const { spec } = await prepare({}, { ...BASE_OPTIONS, cwd: join(work, "wt") });
    expect(spec.runtime.cwd).toBe(join(work, "wt"));
  });

  it("builds a timestamped subagent session name from the description", async () => {
    const { spec } = await prepare();
    expect(spec.session.name).toMatch(/^\d{2}:\d{2}-\[S\]: review the diff$/);
  });

  it("reports unknown builtin tool names as warnings", async () => {
    vi.mocked(getAgentConfig).mockReturnValue({
      ...(vi.mocked(getAgentConfig).mock.results[0]?.value ?? {}),
      builtinToolNames: ["read", "not-a-tool"],
    } as any);
    const { warnings } = await prepare();
    expect(warnings.some((w) => w.includes("not-a-tool"))).toBe(true);
  });
});

describe("constrained-context handoff propagation", () => {
  const cannedHandoff: DeliveredContextHandoff = {
    version: 1,
    content: '===== BEGIN OLIVE EVIDENCE {"path":"a.ts","startLine":1,"endLine":2} =====\nx\n===== END OLIVE EVIDENCE =====\n',
    details: {
      snippets: [{ id: "s1", path: "a.ts", startLine: 1, endLine: 2, bytes: 3, estimatedTokens: 1, sourceHash: "h".repeat(64) }],
      recommendedFiles: [],
      totalBytes: 3,
      estimatedTokens: 1,
    },
  };

  it("carries the approved packet into spec.run.handoff without touching the task", async () => {
    const { spec } = await prepare({}, { ...BASE_OPTIONS, handoff: cannedHandoff });
    expect(spec.run.handoff).toEqual(cannedHandoff);
    expect(spec.run.prompt).toBe("Review the diff");
    expect(spec.run.prompt).not.toContain("OLIVE");
    // Fully serializable — survives a JSON round trip.
    const parsed = JSON.parse(JSON.stringify(spec)) as AgentLaunchSpec;
    expect(parsed.run.handoff).toEqual(cannedHandoff);
  });

  it("omits the packet entirely when none was approved", async () => {
    const { spec } = await prepare();
    expect(spec.run.handoff).toBeUndefined();
  });
});
