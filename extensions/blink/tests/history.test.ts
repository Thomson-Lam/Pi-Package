import test from "node:test";
import assert from "node:assert/strict";

import { BlinkRuntime } from "../runtime.ts";

function runtimeWithSizes(sizes: number[], originSize = 0) {
  const runtime = new BlinkRuntime({
    mode: "blitz",
    cwd: "/tmp",
    ownerPane: "%1",
    reviewScript: "/tmp/review.lua",
    pi: {} as any,
    queueMutation: async (_path, operation) => operation(),
    sinks: new Map(),
  });
  const origin = {
    path: "/tmp/a",
    fileId: "f",
    revision: originSize ? { kind: "file", bytes: Buffer.alloc(0), hash: "x", mode: 0o600 } : { kind: "absent" },
    snapshot: originSize ? { path: "/missing/origin", byteLength: originSize, hash: "x" } : undefined,
  };
  const versions = sizes.map((byteLength, index) => ({
    versionId: index + 1,
    fileId: "f",
    snapshot: { path: `/missing/${index}`, byteLength, hash: "x" },
    byteLength,
    toolCallId: String(index),
    firstChangedLine: 1,
    createdAt: index,
    unread: true,
    displayPath: "a",
    originKind: "absent",
  }));
  (runtime as any).versions = versions;
  (runtime as any).histories.set("f", { origin, versions: [...versions] });
  return runtime;
}

test("100 MiB is inclusive and crossing it evicts globally oldest versions", async () => {
  const MiB = 1024 * 1024;
  const exact = runtimeWithSizes(Array(10).fill(10 * MiB));
  assert.deepEqual(await (exact as any).evictToLimits(), []);
  assert.equal(exact.retainedCount, 10);

  const over = runtimeWithSizes(Array(8).fill(14 * MiB));
  const evicted = await (over as any).evictToLimits();
  assert.deepEqual(evicted, [1]);
  assert.equal(over.retainedCount, 7);
  assert.equal((over as any).versions[0].versionId, 2);

  const originCounts = runtimeWithSizes(Array(10).fill(10 * MiB), 1);
  assert.deepEqual(await (originCounts as any).evictToLimits(), [1]);
  assert.equal(originCounts.retainedCount, 9, "origin snapshot bytes count toward the runtime limit");
});
