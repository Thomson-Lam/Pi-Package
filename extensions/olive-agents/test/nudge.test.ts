/**
 * nudge.test.ts — Completion-notification scheduling: held while the parent
 * agent is busy, delivered at the next idle flush, cancellable by
 * consumption, exactly-once.
 */

import { describe, expect, it, vi } from "vitest";
import { NudgeScheduler } from "../src/nudge.js";

describe("NudgeScheduler", () => {
  it("delivers immediately when the parent is idle", () => {
    const s = new NudgeScheduler();
    const send = vi.fn();
    s.schedule("a", send);
    s.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.pendingCount).toBe(0);
  });

  it("holds while busy and flushes at the idle boundary", () => {
    const s = new NudgeScheduler();
    const send = vi.fn();
    s.setBusy(true);
    s.schedule("a", send);
    s.flush(); // no-op while busy
    expect(send).not.toHaveBeenCalled();
    expect(s.pendingCount).toBe(1);
    s.setBusy(false);
    s.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.pendingCount).toBe(0);
  });

  it("cancel suppresses delivery (consumed result)", () => {
    const s = new NudgeScheduler();
    const send = vi.fn();
    s.setBusy(true);
    s.schedule("a", send);
    s.cancel("a");
    s.setBusy(false);
    s.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers once per nudge", () => {
    const s = new NudgeScheduler();
    const send = vi.fn();
    s.setBusy(true);
    s.schedule("a", send);
    s.setBusy(false);
    s.flush();
    s.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("delivers all pending nudges in one flush", () => {
    const s = new NudgeScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.setBusy(true);
    s.schedule("a", a);
    s.schedule("b", b);
    s.setBusy(false);
    s.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("re-scheduling a key replaces the pending nudge", () => {
    const s = new NudgeScheduler();
    const first = vi.fn();
    const second = vi.fn();
    s.setBusy(true);
    s.schedule("a", first);
    s.schedule("a", second);
    s.setBusy(false);
    s.flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a throwing nudge does not prevent the others", () => {
    const s = new NudgeScheduler();
    const boom = vi.fn(() => { throw new Error("boom"); });
    const ok = vi.fn();
    s.setBusy(true);
    s.schedule("boom", boom);
    s.schedule("ok", ok);
    s.setBusy(false);
    expect(() => s.flush()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("clear drops everything", () => {
    const s = new NudgeScheduler();
    const send = vi.fn();
    s.setBusy(true);
    s.schedule("a", send);
    s.clear();
    s.setBusy(false);
    s.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
