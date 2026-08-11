import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BlinkRuntime } from "../runtime.ts";
import { capturePathState, persistSnapshot, revisionIdentity } from "../revisions.ts";
import { createRuntimeResources } from "../protocol.ts";

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
  const versions = sizes.map((byteLength, index) => ({
    versionId: index + 1,
    fileId: `f${index}`,
    generation: 1,
    snapshot: { path: `/missing/version-${index}`, byteLength, hash: "x" },
    byteLength,
    toolCallId: String(index),
    firstChangedLine: 1,
    createdAt: index,
    unread: true,
    displayPath: `a${index}`,
    absolutePath: `/tmp/a${index}`,
    originKind: originSize && index === 0 ? "file" : "absent",
    originSnapshotPath: originSize && index === 0 ? "/missing/origin" : undefined,
  }));
  (runtime as any).versions = versions;
  for (const [index, version] of versions.entries()) {
    const baselineSnapshot = originSize && index === 0
      ? { path: "/missing/origin", byteLength: originSize, hash: "x" }
      : undefined;
    (runtime as any).files.set(version.fileId, {
      fileId: version.fileId,
      generation: 1,
      absolutePaths: new Set([version.absolutePath]),
      canonicalPaths: new Set(),
      filesystemKeys: new Set(),
      baselineKind: baselineSnapshot ? "file" : "absent",
      baselineSnapshot,
      latest: version,
      lastTouchedAt: index,
    });
    (runtime as any).snapshotByteLengths.set(version.snapshot.path, version.byteLength);
    if (baselineSnapshot) (runtime as any).snapshotByteLengths.set(baselineSnapshot.path, baselineSnapshot.byteLength);
  }
  return runtime;
}

test("logical identity merges hard links, preserves path continuity, and separates basename collisions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "blink-history-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = runtimeWithSizes([]);

  const original = join(dir, "a.txt");
  const alias = join(dir, "alias.txt");
  await writeFile(original, "one");
  await link(original, alias);
  const originalRevision = await capturePathState(original);
  const aliasRevision = await capturePathState(alias);
  const first = await (runtime as any).resolveFile(revisionIdentity(original, originalRevision), originalRevision);
  const linked = await (runtime as any).resolveFile(revisionIdentity(alias, aliasRevision), aliasRevision);
  assert.equal(linked.fileId, first.fileId, "device/inode identity merges hard-link aliases");

  await unlink(original);
  await writeFile(original, "replacement inode");
  const replacement = await capturePathState(original);
  const samePath = await (runtime as any).resolveFile(revisionIdentity(original, replacement), replacement);
  assert.equal(samePath.fileId, first.fileId, "absolute path continuity wins across inode replacement");

  const leftDir = join(dir, "left");
  const rightDir = join(dir, "right");
  await mkdir(leftDir);
  await mkdir(rightDir);
  const left = join(leftDir, "same.txt");
  const right = join(rightDir, "same.txt");
  await writeFile(left, "left");
  await writeFile(right, "right");
  const leftRevision = await capturePathState(left);
  const rightRevision = await capturePathState(right);
  const leftRecord = await (runtime as any).resolveFile(revisionIdentity(left, leftRevision), leftRevision);
  const rightRecord = await (runtime as any).resolveFile(revisionIdentity(right, rightRevision), rightRevision);
  assert.notEqual(leftRecord.fileId, rightRecord.fileId, "basenames alone never merge logical files");
});

test("checkpoint clears retained metadata and recreates an empty private snapshot directory", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "blink-history-checkpoint-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const resources = await createRuntimeResources(base);
  const baseline = await persistSnapshot(resources.snapshotsDir, Buffer.from("before"));
  const latest = await persistSnapshot(resources.snapshotsDir, Buffer.from("after"));
  const runtime = runtimeWithSizes([]);
  (runtime as any).resources = resources;
  const version = {
    versionId: 1,
    fileId: "f",
    generation: 1,
    snapshot: latest,
    byteLength: latest.byteLength,
    toolCallId: "t",
    firstChangedLine: 1,
    createdAt: 1,
    unread: true,
    displayPath: "a.txt",
    absolutePath: "/tmp/a.txt",
    originKind: "file",
    originSnapshotPath: baseline.path,
  };
  (runtime as any).versions = [version];
  (runtime as any).files.set("f", {
    fileId: "f",
    generation: 1,
    absolutePaths: new Set(["/tmp/a.txt"]),
    canonicalPaths: new Set(["/tmp/a.txt"]),
    filesystemKeys: new Set(["1:2"]),
    baselineKind: "file",
    baselineSnapshot: baseline,
    latest: version,
    lastTouchedAt: 1,
  });
  (runtime as any).fileIdByAbsolutePath.set("/tmp/a.txt", "f");
  (runtime as any).fileIdByCanonicalPath.set("/tmp/a.txt", "f");
  (runtime as any).fileIdByFilesystemKey.set("1:2", "f");
  (runtime as any).snapshotByteLengths.set(baseline.path, baseline.byteLength);
  (runtime as any).snapshotByteLengths.set(latest.path, latest.byteLength);
  (runtime as any).preparations.set("pending", { preparationId: "pending", absolutePath: "/tmp/b.txt", pre: { kind: "absent" } });

  const result = await (runtime as any).checkpointBlitzState();
  assert.deepEqual(result, { removedFiles: 1, removedVersions: 1 });
  assert.equal(runtime.retainedCount, 0);
  assert.equal((runtime as any).files.size, 0);
  assert.equal((runtime as any).fileIdByAbsolutePath.size, 0);
  assert.equal((runtime as any).fileIdByCanonicalPath.size, 0);
  assert.equal((runtime as any).fileIdByFilesystemKey.size, 0);
  assert.equal((runtime as any).snapshotByteLengths.size, 0);
  assert.equal((runtime as any).preparations.size, 1, "in-flight mutation preparations survive the checkpoint boundary");
  assert.deepEqual(await readdir(resources.snapshotsDir), []);
  assert.equal((await stat(resources.snapshotsDir)).mode & 0o777, 0o700);
  await runtime.cleanup();
});

test("100 MiB is inclusive and crossing it evicts globally oldest reviewed files", async () => {
  const MiB = 1024 * 1024;
  const exact = runtimeWithSizes(Array(10).fill(10 * MiB));
  assert.deepEqual(await (exact as any).evictToLimits(), []);
  assert.equal(exact.retainedCount, 10);

  const over = runtimeWithSizes(Array(8).fill(14 * MiB));
  const evicted = await (over as any).evictToLimits();
  assert.deepEqual(evicted, [{ fileId: "f0", versionId: 1 }]);
  assert.equal(over.retainedCount, 7);
  assert.equal((over as any).versions[0].versionId, 2);

  const originCounts = runtimeWithSizes(Array(10).fill(10 * MiB), 1);
  assert.deepEqual(await (originCounts as any).evictToLimits(), [{ fileId: "f0", versionId: 1 }]);
  assert.equal(originCounts.retainedCount, 9, "baseline snapshot bytes count toward the runtime limit");
});
