/**
 * child-handoff.test.ts — Building the constrained-context packet as an
 * agent-start message and confirming it lands in the LLM context as a distinct
 * user-role message on the child's first prompt.
 *
 * Delivery goes through before_agent_start: AgentSession's prompt() builds its
 * request list from the agent state + the new task, so pre-appended session
 * entries never reach the payload. Messages returned by a before_agent_start
 * handler are pushed into that request list (role "custom") and converted
 * custom→user by the SDK's convertToLlm before provider serialization.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { buildHandoffMessage, shouldInjectHandoff, wireHandoffBridge } from "../src/child-handoff.mjs";
import type { DeliveredContextHandoff } from "../src/handoff/serialize.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-child-"));
});
afterEach(() => {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
});

function handoff(): DeliveredContextHandoff {
  return {
    version: 1,
    content:
      '===== BEGIN OLIVE EVIDENCE {"path":"a.ts","startLine":1,"endLine":2} =====\n' +
      "x\n" +
      "===== END OLIVE EVIDENCE =====\n",
    details: {
      snippets: [{ id: "s", path: "a.ts", startLine: 1, endLine: 2, bytes: 3, estimatedTokens: 1, sourceHash: "h".repeat(64) }],
      recommendedFiles: [],
      totalBytes: 3,
      estimatedTokens: 1,
    },
  };
}

describe("shouldInjectHandoff", () => {
  it("delivers for a fresh session carrying an approved packet", () => {
    expect(shouldInjectHandoff({ session: {}, run: { handoff: { content: "x", details: {} } } })).toBe(true);
  });

  it("never re-injects when reopening an existing session", () => {
    expect(shouldInjectHandoff({ session: { openFile: "/sessions/x.jsonl" }, run: { handoff: handoff() } })).toBe(false);
  });

  it("skips when no packet was approved", () => {
    expect(shouldInjectHandoff({ session: {}, run: {} })).toBe(false);
    expect(shouldInjectHandoff(undefined)).toBe(false);
  });
});

describe("buildHandoffMessage", () => {
  it("produces a distinct agent-start message with the packet content", () => {
    const message = buildHandoffMessage(handoff())!;
    expect(message.customType).toBe("olive-agent-context");
    expect(message.display).toBe(true);
    expect(message.content).toContain("BEGIN OLIVE EVIDENCE");
    expect(message.content).toContain("END OLIVE EVIDENCE");
  });

  it("returns undefined for undefined and empty packets", () => {
    expect(buildHandoffMessage(undefined)).toBeUndefined();
    expect(buildHandoffMessage({ version: 1, content: "", details: { snippets: [], recommendedFiles: [], totalBytes: 0, estimatedTokens: 0 } })).toBeUndefined();
  });
});

describe("wireHandoffBridge", () => {
  function fakePi() {
    const handlers = new Map<string, Function>();
    return {
      on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
      handlers,
    };
  }
  function freshSpec() {
    return { session: {}, run: { handoff: handoff() } };
  }

  it("registers before_agent_start only for fresh sessions with an approved packet", () => {
    const pi = fakePi();
    wireHandoffBridge(pi, freshSpec());
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));

    const reopenPi = fakePi();
    wireHandoffBridge(reopenPi, { session: { openFile: "/x.jsonl" }, run: { handoff: handoff() } });
    expect(reopenPi.handlers.has("before_agent_start")).toBe(false);

    const nonePi = fakePi();
    wireHandoffBridge(nonePi, { session: {}, run: {} });
    expect(nonePi.handlers.has("before_agent_start")).toBe(false);
  });

  it("injects the packet exactly once per child process", () => {
    const pi = fakePi();
    wireHandoffBridge(pi, freshSpec());
    const handler = pi.handlers.get("before_agent_start")!;
    const first = handler({});
    const second = handler({});
    expect(first).toEqual({ message: expect.objectContaining({ customType: "olive-agent-context", display: true }) });
    expect(first.message.content).toContain("BEGIN OLIVE EVIDENCE");
    expect(second).toBeUndefined();
  });
});

describe("packet reaches the LLM context on the first prompt", () => {
  it("survives the agent-start injection → convertToLlm path as a user message", () => {
    // Mirror what AgentSession.prompt() assembles: the before_agent_start
    // message (role custom) plus the delegated task (role user), then the
    // SDK's per-turn conversion to LLM messages.
    const message = buildHandoffMessage(handoff())!;
    const assembled = [
      { role: "custom", customType: message.customType, content: message.content, display: message.display } as any,
      { role: "user", content: [{ type: "text", text: "the task" }] } as any,
    ];
    const llmMessages = convertToLlm(assembled) as Array<{ role: string; content: unknown }>;
    expect(llmMessages.map((m) => m.role)).toEqual(["user", "user"]);
    const packet = llmMessages.find((m) => {
      const content = m.content;
      const text = typeof content === "string" ? content : JSON.stringify(content);
      return text.includes("BEGIN OLIVE EVIDENCE");
    });
    expect(packet).toBeDefined();
    // The packet arrives as its own message, preceding the task.
    expect(llmMessages.indexOf(packet!)).toBeLessThan(llmMessages.length - 1);
  });
});