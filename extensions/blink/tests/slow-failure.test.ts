import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BlinkRuntime } from "../runtime.ts";

test("Slow tmux startup failure restores the successful built-in mutation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blink-slow-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "a.txt");
  await writeFile(file, "before");
  const ctx: any = {
    cwd: dir,
    isIdle: () => false,
    abort() {},
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name: string, text: string) => text } },
  };
  const runtime = new BlinkRuntime({
    mode: "slow",
    cwd: dir,
    ownerPane: "%1",
    reviewScript: "/missing/review.lua",
    pi: { exec: async () => ({ stdout: "", stderr: "split failed", code: 1 }) } as any,
    queueMutation: async (_path, operation) => operation(),
    sinks: new Map(),
  });
  runtime.setContext(ctx);
  await assert.rejects(runtime.runSlow({
    toolName: "edit",
    toolCallId: "failure",
    params: { path: "a.txt" },
    signal: undefined,
    ctx,
    executeBuiltin: async () => {
      await writeFile(file, "after");
      return { content: [{ type: "text", text: "ok" }], details: { firstChangedLine: 1 } };
    },
  } as any), /cancelled.*restored/i);
  assert.equal(await readFile(file, "utf8"), "before");
  await runtime.cleanup();
});

test("Slow restores an unsupported binary post-state before failing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blink-slow-binary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "a.txt");
  await writeFile(file, "before");
  const ctx: any = {
    cwd: dir,
    isIdle: () => false,
    abort() {},
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name: string, text: string) => text } },
  };
  const runtime = new BlinkRuntime({
    mode: "slow", cwd: dir, ownerPane: "%1", reviewScript: "/missing",
    pi: {} as any,
    queueMutation: async (_path, operation) => operation(),
    sinks: new Map(),
  });
  await assert.rejects(runtime.runSlow({
    toolName: "edit", toolCallId: "binary", params: { path: "a.txt" }, signal: undefined, ctx,
    executeBuiltin: async () => {
      await writeFile(file, Buffer.from([0x61, 0x00, 0x62]));
      return { content: [{ type: "text", text: "ok" }], details: { firstChangedLine: 1 } };
    },
  } as any), /restored.*binary/i);
  assert.equal(await readFile(file, "utf8"), "before");
  await runtime.cleanup();
});
