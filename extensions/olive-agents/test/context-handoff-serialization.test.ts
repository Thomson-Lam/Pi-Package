/**
 * context-handoff-serialization.test.ts — Rendering the approved packet for
 * the child session: exact provenance-bearing evidence, rationale kept out of
 * evidence blocks, leads without contents, and UI-only metadata never leaking
 * into model-facing text.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareContextHandoff } from "../src/handoff/prepare.js";
import {
  isEmptyHandoff,
  serializeContextHandoff,
} from "../src/handoff/serialize.js";
import type { PreparedContextHandoff } from "../src/handoff/types.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-serialize-"));
  writeFileSync(join(work, "a.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(work, "b.ts"), "B1\nB2\nB3\nB4\n");
  writeFileSync(join(work, "markers.txt"), "plain\n--- source text ---\n--- end source text ---\n");
  writeFileSync(join(work, "noise.txt"), "```ts\nconst x = 1; // <tag> & \"quotes\"\n```\n");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function serialize(proposal: Parameters<typeof prepareContextHandoff>[0]) {
  const prepared = await prepareContextHandoff(proposal, { sourceRoot: work });
  return { prepared, delivered: serializeContextHandoff(prepared) };
}

describe("serializeContextHandoff", () => {
  it("serializes snippet provenance without wrapper markers", async () => {
    const { delivered } = await serialize({
      snippets: [{ path: "a.ts", startLine: 2, endLine: 3 }],
    });
    expect(delivered.content).toContain("a.ts:2-3\nline2\nline3");
    expect(delivered.content).not.toContain("OLIVE EVIDENCE");
  });

  it("keeps rationale after the snippet content", async () => {
    const { delivered } = await serialize({
      snippets: [
        { path: "a.ts", startLine: 2, endLine: 2, reason: "the entry point" },
      ],
    });
    const contentIdx = delivered.content.indexOf("line2");
    const reasonIdx = delivered.content.indexOf("Rationale: the entry point");
    expect(reasonIdx).toBeGreaterThan(contentIdx);
  });

  it("serializes recommended files without any file contents", async () => {
    const { delivered } = await serialize({
      snippets: [{ path: "a.ts", startLine: 2, endLine: 2 }],
      recommendedFiles: [
        { path: "b.ts", symbol: "init", reason: "check the setup path" },
      ],
    });
    expect(delivered.content).toContain("- b.ts (symbol: init) — check the setup path");
    expect(delivered.content).not.toContain("OLIVE RECOMMENDED FILES");
    expect(delivered.content).not.toContain("B1");
    expect(delivered.content).not.toContain("line1");
  });

  it("keeps source text exact", async () => {
    const { delivered } = await serialize({
      snippets: [{ path: "markers.txt", startLine: 2, endLine: 3 }],
    });
    expect(delivered.content).toContain("--- source text ---\n--- end source text ---");
  });

  it("keeps backticks and XML-like text verbatim", async () => {
    const { delivered } = await serialize({
      snippets: [{ path: "noise.txt", startLine: 1, endLine: 3 }],
    });
    expect(delivered.content).toContain("```ts");
    expect(delivered.content).toContain('const x = 1; // <tag> & "quotes"');
  });

  it("delivers snippets and leads in the approved order", async () => {
    const { delivered } = await serialize({
      snippets: [
        { path: "a.ts", startLine: 1, endLine: 1 },
        { path: "b.ts", startLine: 1, endLine: 1 },
      ],
    });
    const first = delivered.content.indexOf("a.ts:1-1");
    const second = delivered.content.indexOf("b.ts:1-1");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it("keeps absolute paths and source hashes out of model-facing text", async () => {
    const { prepared, delivered } = await serialize({
      snippets: [{ path: "a.ts", startLine: 2, endLine: 2 }],
    });
    const abs = prepared.snippets[0]!.absolutePath;
    const hash = prepared.snippets[0]!.sourceHash;
    expect(delivered.content).not.toContain(abs);
    expect(delivered.content).not.toContain(hash);
    // They must still be present for the UI / launch verification.
    expect(delivered.details.snippets[0]!.sourceHash).toBe(hash);
  });

  it("carries full per-snippet details for UI and verification", async () => {
    const { delivered } = await serialize({
      snippets: [{ path: "a.ts", startLine: 2, endLine: 2, reason: "why" }],
      recommendedFiles: [{ path: "b.ts" }],
    });
    expect(delivered.details.snippets[0]).toMatchObject({
      path: "a.ts",
      startLine: 2,
      endLine: 2,
      reason: "why",
    });
    expect(delivered.details.snippets[0]!.sourceHash.length).toBe(64);
    expect(delivered.details.recommendedFiles).toEqual([{ path: "b.ts" }]);
    expect(delivered.details.totalBytes).toBeGreaterThan(0);
    expect(delivered.details.estimatedTokens).toBeGreaterThan(0);
  });

  it("produces an empty handoff for an empty packet", async () => {
    const prepared: PreparedContextHandoff = {
      version: 1,
      snippets: [],
      recommendedFiles: [],
      snippetProblems: [],
      leadProblems: [],
      packetProblems: [],
      warnings: [],
      totalBytes: 0,
      estimatedTokens: 0,
    };
    const delivered = serializeContextHandoff(prepared);
    expect(delivered.content).toBe("");
    expect(delivered.details.snippets).toHaveLength(0);
    expect(delivered.details.recommendedFiles).toHaveLength(0);
    expect(isEmptyHandoff(delivered)).toBe(true);
  });
});