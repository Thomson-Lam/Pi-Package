/**
 * context-handoff-freshness.test.ts — Whole-file sha256 verification of an
 * approved packet against the child's launch cwd (decision B).
 *
 * Approval shows content resolved at preparation time; before the child window
 * opens, the launch path re-reads the file at the child's working directory
 * and compares whole-file hashes. Any edit — even outside the selected range —
 * invalidates the review because line attribution may have shifted.
 */

import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareContextHandoff,
  reducePreparedContext,
} from "../src/handoff/prepare.js";
import { verifyHandoffFreshness } from "../src/handoff/freshness.js";
import { serializeContextHandoff } from "../src/handoff/serialize.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-fresh-"));
  writeFileSync(join(work, "a.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(work, "b.ts"), "B1\nB2\n");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function handoff(proposal: Parameters<typeof prepareContextHandoff>[0]) {
  const prepared = await prepareContextHandoff(proposal, { sourceRoot: work });
  return { prepared, delivered: serializeContextHandoff(prepared) };
}

function verify(delivered: ReturnType<typeof serializeContextHandoff>) {
  return verifyHandoffFreshness(delivered, work);
}

describe("verifyHandoffFreshness", () => {
  it("passes an unchanged source", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 2 }],
    });
    expect(await verify(delivered)).toEqual([]);
  });

  it("fails when the selected lines change", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 2 }],
    });
    writeFileSync(join(work, "a.ts"), "line1\nCHANGED\nline3\n");
    const failures = await verify(delivered);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("a.ts:1-2");
    expect(failures[0]).toContain("changed after it was reviewed");
  });

  it("fails when content outside the selected range changes (whole-file strictness)", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 2, endLine: 2 }],
    });
    // Edit line 1 — the reviewed line 2 text is identical, but attribution
    // could have shifted, so the whole-file hash must still fail.
    writeFileSync(join(work, "a.ts"), "EDITED ABOVE\nline2\nline3\n");
    expect(await verify(delivered)).toHaveLength(1);
  });

  it("fails when the file is deleted", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 1 }],
    });
    unlinkSync(join(work, "a.ts"));
    const failures = await verify(delivered);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no longer available");
  });

  it("fails when the file becomes a symlink escaping the root", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 1 }],
    });
    // Target exists so realpath resolves OUTSIDE the root.
    const outside = join(work, "..", `outside-fresh-${process.pid}.ts`);
    writeFileSync(outside, "export {};\n");
    unlinkSync(join(work, "a.ts"));
    symlinkSync(outside, join(work, "a.ts"));
    expect(await verify(delivered)).toHaveLength(1);
  });

  it("fails when the file becomes binary", async () => {
    const { delivered } = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 1 }],
    });
    writeFileSync(join(work, "a.ts"), Buffer.from([0x00, 0x01]));
    expect(await verify(delivered)).toHaveLength(1);
  });

  it("lets the remaining packet launch after the changed item is removed", async () => {
    const { prepared, delivered } = await handoff({
      snippets: [
        { path: "a.ts", startLine: 1, endLine: 1 },
        { path: "b.ts", startLine: 1, endLine: 1 },
      ],
    });
    writeFileSync(join(work, "a.ts"), "CHANGED\nline2\nline3\n");
    const reduced = reducePreparedContext(prepared, new Set([prepared.snippets[0]!.id]));
    const redelivered = serializeContextHandoff(reduced);
    expect(await verify(redelivered)).toEqual([]);
  });

  it("re-preparation produces a fresh hash the new packet verifies against", async () => {
    const first = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 2 }],
    });
    writeFileSync(join(work, "a.ts"), "NEW1\nNEW2\nline3\n");
    expect(await verify(first.delivered)).toHaveLength(1);

    const second = await handoff({
      snippets: [{ path: "a.ts", startLine: 1, endLine: 2 }],
    });
    expect(second.prepared.snippets[0]!.content).toBe("NEW1\nNEW2");
    expect(await verify(second.delivered)).toEqual([]);
  });
});