import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import {
  MAX_FILE_BYTES,
  RevisionConflictError,
  capturePathState,
  filesystemKey,
  hashBytes,
  normalizeToolPath,
  revisionIdentity,
  restorePathState,
  validateTextBytes,
} from "../revisions.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "blink-revisions-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })); });
  return dir;
}

test("normalizes a leading @ and resolves against cwd", async (t) => {
  const dir = await fixture(t);
  assert.equal(normalizeToolPath("@src/a.ts", dir), join(dir, "src/a.ts"));
});

test("captures absent and existing regular text origins including mode", async (t) => {
  const dir = await fixture(t);
  const missing = join(dir, "new.txt");
  assert.deepEqual(await capturePathState(missing, { allowAbsent: true }), { kind: "absent" });

  const file = join(dir, "a.txt");
  const bytes = Buffer.from("alpha\r\nbeta", "utf8");
  await writeFile(file, bytes, { mode: 0o640 });
  await chmod(file, 0o640);
  const state = await capturePathState(file);
  assert.equal(state.kind, "file");
  if (state.kind === "file") {
    assert.deepEqual(state.bytes, bytes);
    assert.equal(state.hash, hashBytes(bytes));
    assert.equal(state.mode & 0o777, 0o640);
  }
});

test("captures canonical path and stable filesystem identity across hard links", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "a.txt");
  const alias = join(dir, "alias.txt");
  await writeFile(file, "same inode");
  await link(file, alias);
  const original = await capturePathState(file);
  const linked = await capturePathState(alias);
  assert.equal(original.kind, "file");
  assert.equal(linked.kind, "file");
  if (original.kind === "file" && linked.kind === "file") {
    assert.equal(filesystemKey(revisionIdentity(file, original)), filesystemKey(revisionIdentity(alias, linked)));
    assert.equal(original.canonicalPath, file);
    assert.equal(linked.canonicalPath, alias);
  }
});

test("text validation accepts the inclusive size boundary", () => {
  assert.doesNotThrow(() => validateTextBytes(Buffer.alloc(MAX_FILE_BYTES, 0x61)));
  assert.throws(() => validateTextBytes(Buffer.alloc(MAX_FILE_BYTES + 1, 0x61)), /15 MiB/);
});

test("text validation rejects NUL and invalid UTF-8", () => {
  assert.throws(() => validateTextBytes(Buffer.from([0x61, 0x00, 0x62])), /binary/);
  assert.throws(() => validateTextBytes(Buffer.from([0xc3, 0x28])), /UTF-8/);
});

test("capture rejects symlinks and non-regular paths without following", async (t) => {
  const dir = await fixture(t);
  const target = join(dir, "target.txt");
  const link = join(dir, "link.txt");
  await writeFile(target, "ok");
  await symlink(target, link);
  await assert.rejects(capturePathState(link), /symlink/);
  await assert.rejects(capturePathState(dir), /regular file/);
});

test("existing-file restore is compare-and-swap, atomic, and mode preserving", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "a.txt");
  await writeFile(file, "before", { mode: 0o600 });
  await chmod(file, 0o600);
  const pre = await capturePathState(file);
  assert.equal(pre.kind, "file");
  await writeFile(file, "after");
  const postHash = hashBytes(Buffer.from("after"));
  await restorePathState(file, pre, postHash);
  assert.equal(await readFile(file, "utf8"), "before");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("absent restore deletes only a matching new regular file", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "new.txt");
  await writeFile(file, "generated");
  await restorePathState(file, { kind: "absent" }, hashBytes(Buffer.from("generated")));
  await assert.rejects(lstat(file), { code: "ENOENT" });
});

test("restore refuses changed bytes and preserves the newer state", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "a.txt");
  await writeFile(file, "before");
  const pre = await capturePathState(file);
  await writeFile(file, "newer");
  await assert.rejects(
    restorePathState(file, pre, hashBytes(Buffer.from("expected-post"))),
    RevisionConflictError,
  );
  assert.equal(await readFile(file, "utf8"), "newer");
});

test("restore refuses an unexpected path type", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "new.txt");
  await mkdir(file);
  await assert.rejects(restorePathState(file, { kind: "absent" }, hashBytes(Buffer.from("x"))), RevisionConflictError);
});
