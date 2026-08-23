/**
 * context-handoff-bounds.test.ts — Reader-level safety bounds: read-time path
 * containment (closing the missing-target symlink TOCTOU) and the bounded
 * streaming reader (peak retained content never exceeds the excerpt cap, while
 * the whole-file hash is still computed over the full stream).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareContextHandoff } from "../src/handoff/prepare.js";
import { createWorkingTreeReader } from "../src/handoff/source.js";
import type { ContextSourceReader } from "../src/handoff/types.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-bounds-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("read-time containment (TOCTOU)", () => {
  it("reports missing while the symlink target is absent, then refuses to read once it appears outside", async () => {
    // The symlink points at a DIRECTORY outside the root so that
    // `<symlink>/new.txt` is a valid path once the directory exists.
    const outsideRoot = join(work, "..", `outside-dir-${process.pid}`);
    const reader = createWorkingTreeReader();
    symlinkSync(outsideRoot, join(work, "outlink"));
    try {
      const first = await reader
        .readRange({
          sourceRoot: work,
          relativePath: "outlink/new.txt",
          startLine: 1,
          endLine: 1,
          maxExcerptBytes: 1000,
        })
        .catch((error) => error?.kind);
      expect(first).toBe("missing");

      // Target created between normalize and read — the read must re-canonicalize
      // and refuse the escape instead of following the symlink outside the root.
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(join(outsideRoot, "new.txt"), "secret\n");
      const second = await reader
        .readRange({
          sourceRoot: work,
          relativePath: "outlink/new.txt",
          startLine: 1,
          endLine: 1,
          maxExcerptBytes: 1000,
        })
        .catch((error) => error?.kind);
      expect(second).toBe("invalid-path");
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses a direct symlink-to-outside at read time", async () => {
    const outside = join(work, "..", `outside-direct-${process.pid}.txt`);
    writeFileSync(outside, "export {};\n");
    symlinkSync(outside, join(work, "escape.ts"));
    const reader = createWorkingTreeReader();
    const kind = await reader
      .readRange({
        sourceRoot: work,
        relativePath: "escape.ts",
        startLine: 1,
        endLine: 1,
        maxExcerptBytes: 1000,
      })
      .catch((error) => error?.kind);
    expect(kind).toBe("invalid-path");
  });
});

describe("bounded streaming reader (memory)", () => {
  it("prepares a 100k-line file via the injected reader retaining only the requested line", async () => {
    const real = createWorkingTreeReader();
    const seen: string[] = [];
    const spyReader: ContextSourceReader = {
      ...real,
      readRange: async (input) => {
        const result = await real.readRange(input);
        seen.push(result.content);
        return result;
      },
    };

    const body = Array.from({ length: 100_000 }, (_, i) => `line${i}`).join("\n") + "\n";
    writeFileSync(join(work, "big.txt"), body);

    const prepared = await prepareContextHandoff(
      { snippets: [{ path: "big.txt", startLine: 1, endLine: 1 }] },
      { sourceRoot: work, limits: { maxSnippets: 12, maxRecommendedFiles: 12, maxLinesPerSnippet: 400, maxBytesPerSnippet: 64_000, maxPacketTokens: 40_000 }, reader: spyReader },
    );
    // The injected reader was the one called — content stays bounded to line 1.
    expect(seen).toEqual(["line0"]);
    expect(prepared.snippets[0]!.content).toBe("line0");
    // The whole-file hash is still computed over the full stream.
    expect(prepared.snippets[0]!.sourceHash).toBe(sha256(body));
  });

  it("aborts early as oversized when the excerpt exceeds the byte cap mid-stream", async () => {
    const reader = createWorkingTreeReader();
    // Line 1 is tiny; lines 2..3 exceed the cap — the reader must reject the
    // span without yielding the whole file.
    writeFileSync(join(work, "mid.txt"), "tiny\n" + "x".repeat(10_000) + "\ny\n");
    const kind = await reader
      .readRange({
        sourceRoot: work,
        relativePath: "mid.txt",
        startLine: 2,
        endLine: 3,
        maxExcerptBytes: 1024,
      })
      .catch((error) => error?.kind);
    expect(kind).toBe("oversized");
  });

  it("R03 — the byte cap counts line-separator bytes of the joined excerpt", async () => {
    const reader = createWorkingTreeReader();
    // Two 5-byte lines: the joined excerpt is 11 bytes (10 + 1 separator).
    // A cap of 10 must reject it — counting only captured line text would
    // accept it and deliver 11 bytes.
    writeFileSync(join(work, "sep.txt"), "abcde\nfghij\n");
    const kind = await reader
      .readRange({
        sourceRoot: work,
        relativePath: "sep.txt",
        startLine: 1,
        endLine: 2,
        maxExcerptBytes: 10,
      })
      .catch((error) => error?.kind);
    expect(kind).toBe("oversized");
    // One separator byte under the cap is accepted.
    const ok = await reader.readRange({
      sourceRoot: work,
      relativePath: "sep.txt",
      startLine: 1,
      endLine: 2,
      maxExcerptBytes: 11,
    });
    expect(ok.content).toBe("abcde\nfghij");
    expect(ok.bytes).toBe(11);
  });
});