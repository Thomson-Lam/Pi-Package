import test from "node:test";
import assert from "node:assert/strict";

import { BlinkRuntime } from "../runtime.ts";

function envelope(type: string, payload: any, requestId = `${type}-1`) {
  return { protocolVersion: 1 as const, type, reviewId: "ignored", requestId, payload };
}

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
