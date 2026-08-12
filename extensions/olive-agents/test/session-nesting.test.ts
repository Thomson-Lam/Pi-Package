/**
 * session-nesting.test.ts — Child agent sessions are persisted Pi sessions
 * whose headers point at the parent session file, so /resume renders them
 * nested beneath the parent (Threaded sort, empty search).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let work: string;
let parentFile: string;
let parent: SessionManager;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "olive-session-nesting-"));
  parent = SessionManager.create(work, work);
  parentFile = parent.getSessionFile()!;
  // Persist at least one assistant message so the file is flushed to disk.
  parent.appendMessage({ role: "user", content: "Start a session" });
  parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Session started" }],
    provider: "test", model: "basic", stopReason: "stop",
  } as never);
});

afterEach(() => { rmSync(work, { recursive: true, force: true }); });

describe("nested agent sessions", () => {
  it("creates a child whose header points at the parent session file", async () => {
    const child = SessionManager.create(work, work, {
      id: "child-session-uuid",
      parentSession: parentFile,
    });
    child.appendSessionInfo("Agent · Review · inspect auth · a1b2c3d4");

    // The header is written lazily; append a message so the file exists.
    child.appendMessage({ role: "user", content: "Review the diff" });
    child.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      provider: "test", model: "basic", stopReason: "stop",
    } as never);

    const childFile = child.getSessionFile()!;
    expect(existsSync(childFile)).toBe(true);

    // Listing must surface the parent relationship.
    const sessions = await SessionManager.list(work, work);
    const info = sessions.find((s) => s.path === childFile);
    expect(info).toBeDefined();
    expect(info!.parentSessionPath).toBe(parentFile);
    expect(info!.name).toContain("Agent · Review");
  });

  it("siblings share the parent and list as peers", async () => {
    const a = SessionManager.create(work, work, { id: "a-uuid", parentSession: parentFile });
    const b = SessionManager.create(work, work, { id: "b-uuid", parentSession: parentFile });
    a.appendMessage({ role: "user", content: "task a" });
    a.appendMessage({ role: "assistant", content: [{ type: "text", text: "a done" }], provider: "test", model: "basic", stopReason: "stop" } as never);
    b.appendMessage({ role: "user", content: "task b" });
    b.appendMessage({ role: "assistant", content: [{ type: "text", text: "b done" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const sessions = await SessionManager.list(work, work);
    const children = sessions.filter((s) => s.parentSessionPath === parentFile);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.path).sort()).toEqual([a.getSessionFile()!, b.getSessionFile()!].sort());
  });

  it("opening a child file restores its history and name", async () => {
    const child = SessionManager.create(work, work, { id: "child-uuid", parentSession: parentFile });
    child.appendSessionInfo("Agent · Review · verify diff · 91ee204b");
    child.appendMessage({ role: "user", content: "Verify the diff" });
    child.appendMessage({ role: "assistant", content: [{ type: "text", text: "Verified" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const reopened = SessionManager.open(child.getSessionFile()!);
    expect(reopened.getSessionName()).toBe("Agent · Review · verify diff · 91ee204b");
    expect(reopened.getSessionId()).toBe("child-uuid");
    const entries = reopened.getEntries();
    expect(entries.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "Verify the diff")).toBe(true);
  });

  it("a session without a parent lists as a root (ephemeral-parent case)", async () => {
    const standalone = SessionManager.create(work, work);
    standalone.appendMessage({ role: "user", content: "solo" });
    standalone.appendMessage({ role: "assistant", content: [{ type: "text", text: "solo done" }], provider: "test", model: "basic", stopReason: "stop" } as never);

    const sessions = await SessionManager.list(work, work);
    const info = sessions.find((s) => s.path === standalone.getSessionFile()!);
    expect(info!.parentSessionPath).toBeUndefined();
  });
});
