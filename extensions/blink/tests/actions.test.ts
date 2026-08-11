import test from "node:test";
import assert from "node:assert/strict";

import { BlinkRuntime } from "../runtime.ts";

function envelope(type: string, payload: any, requestId = `${type}-1`) {
  return { protocolVersion: 2 as const, type, reviewId: "ignored", requestId, payload };
}

function closeRuntime() {
  const replies: Array<{ type: string; payload: any; requestId?: string }> = [];
  const runtime = new BlinkRuntime({
    mode: "blitz",
    cwd: "/tmp",
    ownerPane: "%1",
    reviewScript: "/tmp/review.lua",
    pi: {} as any,
    queueMutation: async (_path, operation) => operation(),
    sinks: new Map(),
  });
  (runtime as any).clientReady = true;
  (runtime as any).server = { send: (type: string, payload: any, requestId?: string) => { replies.push({ type, payload, requestId }); return true; } };
  return { runtime, replies };
}

test("Blitz close actions distinguish retained history from an idempotent checkpoint", async () => {
  const retained = closeRuntime();
  (retained.runtime as any).versions = [{ versionId: 1, fileId: "f" }];
  await (retained.runtime as any).handleMessage(envelope("client_retain_close", {}, "retain"));
  assert.equal(retained.runtime.retainedCount, 1);
  assert.deepEqual(retained.replies.at(-1)?.payload, { action: "retain", reset: false, retainedCount: 1 });
  await (retained.runtime as any).completeClientClose();

  const checkpoint = closeRuntime();
  let resets = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  (checkpoint.runtime as any).checkpointBlitzState = async () => {
    resets++;
    await wait;
    (checkpoint.runtime as any).versions = [];
    return { removedFiles: 1, removedVersions: 1 };
  };
  const request = envelope("client_checkpoint_close", {}, "checkpoint");
  const first = (checkpoint.runtime as any).handleMessage(request);
  const duplicate = (checkpoint.runtime as any).handleMessage(request);
  await duplicate;
  assert.equal(resets, 1, "duplicate in-flight checkpoint requests reset once");
  assert.equal(checkpoint.replies.at(-1)?.type, "client_close_pending");
  release();
  await first;
  assert.deepEqual(checkpoint.replies.at(-1)?.payload, {
    action: "checkpoint",
    reset: true,
    retainedCount: 0,
    removedFiles: 1,
    removedVersions: 1,
  });
  await (checkpoint.runtime as any).completeClientClose();
});

test("Blitz feedback routing, TODO isolation/idempotency, and abort are mode-correct", async () => {
  const sent: Array<{ text: string; options?: any }> = [];
  let aborts = 0;
  let idle = false;
  let submissions = 0;
  let releaseSink!: () => void;
  const sinkWait = new Promise<void>((resolve) => { releaseSink = resolve; });
  const sinks = new Map([
    ["todo", { id: "todo", label: "TODO", submit: async () => { submissions++; await sinkWait; } }],
  ]);
  const pi: any = {
    sendUserMessage: (text: string, options?: any) => sent.push({ text, options }),
  };
  const ctx: any = {
    cwd: "/tmp",
    isIdle: () => idle,
    abort: () => { aborts++; },
    ui: { notify() {}, setStatus() {}, theme: { fg: (_name: string, text: string) => text } },
  };
  const runtime = new BlinkRuntime({
    mode: "blitz",
    cwd: "/tmp",
    ownerPane: "%1",
    reviewScript: "/tmp/review.lua",
    pi,
    queueMutation: async (_path, operation) => operation(),
    sinks: sinks as any,
  });
  runtime.setContext(ctx);
  (runtime as any).clientReady = true;
  (runtime as any).versions = [{ versionId: 1, fileId: "f", displayPath: "a.ts" }];

  await (runtime as any).handleMessage(envelope("submit_agent_feedback", { versionId: 1, fileId: "f", comment: "check this" }));
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
  assert.match(sent[0].text, /a\.ts.*version 1.*check this/s);
  idle = true;
  await (runtime as any).handleMessage(envelope("submit_agent_feedback", { versionId: 1, fileId: "f", comment: "idle" }, "feedback-2"));
  assert.equal(sent[1].options, undefined);

  const todo = envelope("submit_todo", { versionId: 1, fileId: "f", sinkId: "todo", comment: "never model context" }, "same-todo");
  const first = (runtime as any).handleMessage(todo);
  const duplicate = (runtime as any).handleMessage(todo);
  await duplicate;
  assert.equal(submissions, 1, "duplicate in-flight TODO must not submit twice");
  assert.equal(sent.length, 2, "TODO feedback never enters model context");
  releaseSink();
  await first;

  idle = false;
  await (runtime as any).handleMessage(envelope("abort_agent", {}, "abort-1"));
  await (runtime as any).handleMessage(envelope("abort_agent", {}, "abort-2"));
  assert.equal(aborts, 1);
  runtime.agentStarted(ctx);
  await (runtime as any).handleMessage(envelope("abort_agent", {}, "abort-3"));
  assert.equal(aborts, 2, "a later agent run can be aborted independently");
});
