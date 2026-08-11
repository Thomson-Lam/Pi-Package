import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { load } from "./helpers.mjs";

const { prepareSelectedFiles, verifyPreparedFilesUnchanged } = await load("../src/fresh/files.ts");
const limits = { maxLedgerFiles: 500, maxSelectedFiles: 24, maxFileBytes: 20, maxTransferTokens: 50_000 };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ctx-fresh-"));
  await mkdir(path.join(root, "src"));
  const candidate = (relative) => ({ path: relative, absolutePath: path.join(root, relative) });
  return { root, candidate };
}

test("preparation reads current whole UTF-8 files and reports exclusions", async () => {
  const { root, candidate } = await fixture();
  await writeFile(path.join(root, "src/a.ts"), "current contents");
  await writeFile(path.join(root, "src/big.ts"), "x".repeat(21));
  await writeFile(path.join(root, "src/binary"), Buffer.from([65, 0, 66]));
  const candidates = [candidate("src/a.ts"), candidate("src/big.ts"), candidate("src/binary"), candidate("src/missing.ts")];
  const prepared = await prepareSelectedFiles(candidates.map((item) => item.path), { version: 1, projectRoot: root, candidates }, limits);
  assert.equal(prepared.included[0].content, "current contents");
  assert.deepEqual(prepared.excluded.map((item) => item.reason), ["oversized", "unsupported", "missing"]);
});

test("preparation rejects symlinks outside the project", async () => {
  const { root, candidate } = await fixture();
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "ctx-outside-")), "secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, path.join(root, "src/link.txt"));
  const link = candidate("src/link.txt");
  const prepared = await prepareSelectedFiles([link.path], { version: 1, projectRoot: root, candidates: [link] }, limits);
  assert.equal(prepared.excluded[0].reason, "outside-project");
  assert.match(prepared.blockedReason, /No selected files/);
});

test("verification detects changes after review", async () => {
  const { root, candidate } = await fixture();
  const file = candidate("src/a.ts");
  await writeFile(file.absolutePath, "before");
  const prepared = await prepareSelectedFiles([file.path], { version: 1, projectRoot: root, candidates: [file] }, limits);
  await verifyPreparedFilesUnchanged(prepared.included, root);
  await writeFile(file.absolutePath, "after");
  await assert.rejects(() => verifyPreparedFilesUnchanged(prepared.included, root), /changed after it was reviewed/);
});

test("combined token limits block rather than silently dropping files", async () => {
  const { root, candidate } = await fixture();
  const file = candidate("src/a.ts");
  await writeFile(file.absolutePath, "12345678");
  const prepared = await prepareSelectedFiles([file.path], { version: 1, projectRoot: root, candidates: [file] }, { ...limits, maxTransferTokens: 1 });
  assert.equal(prepared.included.length, 1);
  assert.match(prepared.blockedReason, /exceeds/);
});
