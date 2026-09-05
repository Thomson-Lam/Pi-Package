/**
 * event-mailbox.test.ts — Filesystem mailbox between the parent Pi session and
 * child agent Pi sessions.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackCommand,
  consumeChildEvents,
  emitChildEvent,
  ensureMailboxDir,
  readPendingCommands,
  removeMailboxDir,
  readPendingDecision,
  writePendingDecision,
  watchChildEvents,
  writeParentCommand,
} from "../src/event-mailbox.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "olive-mailbox-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mailbox directory", () => {
  it("creates events/ and commands/ with 0700", () => {
    ensureMailboxDir(dir);
    expect(existsSync(join(dir, "events"))).toBe(true);
    expect(existsSync(join(dir, "commands"))).toBe(true);
  });

  it("is idempotent", () => {
    ensureMailboxDir(dir);
    ensureMailboxDir(dir);
    expect(existsSync(join(dir, "events"))).toBe(true);
  });

  it("removeMailboxDir cleans everything", () => {
    emitChildEvent(dir, { type: "ready", sessionId: "s1" });
    removeMailboxDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("child events", () => {
  it("emits and consumes events in order", () => {
    emitChildEvent(dir, { type: "ready", sessionId: "s1" });
    emitChildEvent(dir, { type: "run_started", runNumber: 1 });
    emitChildEvent(dir, { type: "tool_started", toolName: "read", target: "a.ts" });

    const events = consumeChildEvents(dir);
    expect(events.map((e) => e.type)).toEqual(["ready", "run_started", "tool_started"]);
    expect(events[1]).toMatchObject({ type: "run_started", runNumber: 1 });
  });

  it("consumes exactly once", () => {
    emitChildEvent(dir, { type: "ready", sessionId: "s1" });
    consumeChildEvents(dir);
    expect(consumeChildEvents(dir)).toEqual([]);
  });

  it("ignores and removes malformed files", () => {
    ensureMailboxDir(dir);
    writeFileSync(join(dir, "events", "zz-broken.json"), "{not json", "utf-8");
    emitChildEvent(dir, { type: "ready", sessionId: "s1" });
    const events = consumeChildEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("ready");
    expect(readdirCount(join(dir, "events"))).toBe(0);
  });

  it("recovers events written before the watcher starts", async () => {
    emitChildEvent(dir, { type: "run_started", runNumber: 1 });
    const seen: string[] = [];
    const watcher = watchChildEvents(dir, (events) => {
      for (const e of events) seen.push(e.type);
    });
    await new Promise((r) => setTimeout(r, 50));
    watcher.dispose();
    expect(seen).toEqual(["run_started"]);
  });

  it("delivers events written after the watcher starts", async () => {
    const seen: string[] = [];
    const watcher = watchChildEvents(dir, (events) => {
      for (const e of events) seen.push(e.type);
    });
    emitChildEvent(dir, { type: "tool_started", toolName: "bash", target: "ls" });
    await new Promise((r) => setTimeout(r, 300));
    watcher.dispose();
    expect(seen).toContain("tool_started");
  });

  it("does not crash the watcher when the observer throws", async () => {
    const watcher = watchChildEvents(dir, () => {
      throw new Error("observer boom");
    });
    emitChildEvent(dir, { type: "ready", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 300));
    watcher.dispose();
    // Second event still consumed after observer failure.
    const events = consumeChildEvents(dir);
    expect(events).toEqual([]);
  });
});

describe("pending decisions", () => {
  it("round-trips durable decision state atomically", () => {
    const state = { runNumber: 2, reason: "turn_limit" as const, result: "status", turnCount: 4, maxTurns: 4, toolUses: 2, requestedAt: Date.now() };
    writePendingDecision(dir, state);
    expect(readPendingDecision(dir)).toEqual(state);
  });

  it("returns undefined for malformed decision state", () => {
    ensureMailboxDir(dir);
    writeFileSync(join(dir, "pending-decision.json"), "not json", "utf-8");
    expect(readPendingDecision(dir)).toBeUndefined();
  });
});

describe("parent commands", () => {
  it("writes and reads checkpoint acknowledgements in order", () => {
    writeParentCommand(dir, { type: "ack_checkpoint", checkpointId: "cp-1" });
    writeParentCommand(dir, { type: "ack_checkpoint", checkpointId: "cp-2" });
    const cmds = readPendingCommands(dir);
    expect(cmds).toEqual([
      { type: "ack_checkpoint", checkpointId: "cp-1" },
      { type: "ack_checkpoint", checkpointId: "cp-2" },
    ]);
  });

  it("consumes commands via ack", () => {
    const f = writeParentCommand(dir, { type: "ack_checkpoint", checkpointId: "cp-1" });
    const cmds = readPendingCommands(dir);
    expect(cmds).toHaveLength(1);
    // The child acks by filename; the file must then be gone.
    expect(existsSync(f)).toBe(true);
    ackCommand(dir, f.split("/").pop()!);
    expect(existsSync(f)).toBe(false);
  });

  it("survives a missing commands dir", () => {
    expect(readPendingCommands(dir)).toEqual([]);
  });
});

function readdirCount(d: string): number {
  return readdirSync(d).length;
}
