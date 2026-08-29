import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(),
  getAgentConfig: vi.fn(),
}));

import { getAgentConfig, getConfig } from "../src/agent-types.js";
import { prepareAgentLaunch, setDefaultMaxTurns, setGraceTurns } from "../src/agent-runner.js";
import type { AgentLaunchSpec } from "../src/types.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-runner-test-"));
  vi.mocked(getConfig).mockReturnValue({
    displayName: "Review", description: "Review", builtinToolNames: [],
    extensions: true, skills: false,
  } as any);
  vi.mocked(getAgentConfig).mockReturnValue({
    name: "Review", displayName: "Review", description: "Review",
    extensions: true, skills: false, systemPrompt: "You are a reviewer.",
  } as any);
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function makePi() {
  return {
    getActiveTools: vi.fn(() => ["read", "custom_tool"]),
    getAllTools: vi.fn(() => [
      { name: "read", sourceInfo: { path: "<builtin:read>" } },
      { name: "custom_tool", sourceInfo: { path: "/project/custom.ts" } },
      { name: "inactive_tool", sourceInfo: { path: "/project/inactive.ts" } },
    ]),
  } as any;
}

function makeCtx() {
  return {
    cwd: work,
    model: { provider: "test", id: "basic", name: "Basic", reasoning: false },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => join(work, "parent.jsonl"),
      getSessionDir: () => work,
    },
  } as any;
}

async function prepare(options: any = { model: { provider: "test", id: "basic" }, thinking: "high", maxTurns: 10 }) {
  return prepareAgentLaunch({
    pi: makePi(), ctx: makeCtx(), type: "Review", prompt: "Review the diff",
    description: "review the diff", options, agentId: "agent-id",
    childSessionId: "child-session", parentSessionFile: join(work, "parent.jsonl"),
    sessionDir: work, mailboxDir: join(work, "mailbox"),
  });
}

describe("prepareAgentLaunch", () => {
  it("creates a fresh replacement-prompt spec in the parent cwd", async () => {
    const { spec } = await prepare();
    expect(spec.runtime.cwd).toBe(work);
    expect(spec.runtime.tools).toEqual(["read", "custom_tool"]);
    expect(spec.runtime.extensionPaths).toEqual(["/project/custom.ts", "/project/inactive.ts"]);
    expect(spec.runtime.noExtensions).toBe(false);
    expect(spec.run.prompt).toBe("Review the diff");
    expect(spec.run).not.toHaveProperty("handoff");
    expect(spec.runtime.systemPrompt).not.toContain("parent system prompt");
    const parsed = JSON.parse(JSON.stringify(spec)) as AgentLaunchSpec;
    expect(parsed.runtime.tools).toEqual(spec.runtime.tools);
  });

  it("applies max-turn defaults", async () => {
    setDefaultMaxTurns(20);
    setGraceTurns(3);
    const { spec } = await prepare({ model: { provider: "test", id: "basic" }, thinking: "high" });
    expect(spec.run.maxTurns).toBe(20);
    expect(spec.run.graceTurns).toBe(3);
  });
});
