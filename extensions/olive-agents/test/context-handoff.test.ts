/**
 * context-handoff.test.ts — Proposal normalization, resolution, dedup, and
 * size enforcement for the constrained-context packet.
 *
 * These encode the frozen contract: the model proposes references, Olive
 * supplies exact content, invalid references are problems (never repaired),
 * and packets are bounded by per-snippet and total limits.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareContextHandoff,
  reducePreparedContext,
} from "../src/handoff/prepare.js";
import { estimateTokens } from "../src/handoff/source.js";
import { serializeContextHandoff } from "../src/handoff/serialize.js";
import {
  DEFAULT_CONTEXT_HANDOFF_LIMITS,
  type ContextHandoffLimits,
  type ContextHandoffProposal,
} from "../src/handoff/types.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "olive-handoff-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function seedFiles() {
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "src", "a.ts"), "line1\nline2\nline3\nline4\n");
  writeFileSync(join(work, "multi.txt"), "alpha\nbeta\ngamma"); // no trailing newline
  writeFileSync(join(work, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  mkdirSync(join(work, "subdir"), { recursive: true });
  writeFileSync(join(work, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
  writeFileSync(join(work, "bad-utf8.txt"), Buffer.from([0xff, 0x61]));
  // Symlink that escapes the root (target must exist for realpath to escape).
  const outside = join(work, "..", `outside-${process.pid}.ts`);
  writeFileSync(outside, "export {};\n");
  symlinkSync(outside, join(work, "link.ts"));
}

function prepare(proposal: ContextHandoffProposal, limits?: ContextHandoffLimits) {
  return prepareContextHandoff(proposal, { sourceRoot: work, limits });
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("default limits", () => {
  it("match the agreed conservative bounds (#1/#6)", () => {
    expect(DEFAULT_CONTEXT_HANDOFF_LIMITS).toEqual({
      maxSnippets: 12,
      maxRecommendedFiles: 12,
      maxLinesPerSnippet: 400,
      maxBytesPerSnippet: 64_000,
      maxPacketTokens: 40_000,
    });
  });
});

describe("prepareContextHandoff — resolution and normalization", () => {
  beforeEach(seedFiles);

  it("resolves a valid range to the exact requested lines", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 2, endLine: 3 }],
    });
    expect(prepared.snippets).toHaveLength(1);
    const s = prepared.snippets[0]!;
    expect(s.path).toBe("src/a.ts");
    expect(s.startLine).toBe(2);
    expect(s.endLine).toBe(3);
    expect(s.content).toBe("line2\nline3");
    expect(s.bytes).toBe(Buffer.byteLength("line2\nline3", "utf8"));
    expect(s.estimatedTokens).toBeGreaterThan(0);
    expect(s.sourceHash).toBe(sha256("line1\nline2\nline3\nline4\n"));
    expect(s.absolutePath).toBe(join(work, "src", "a.ts"));
    expect(prepared.snippetProblems).toHaveLength(0);
  });

  it("preserves CRLF and internal newlines verbatim", async () => {
    const prepared = await prepare({
      snippets: [{ path: "crlf.txt", startLine: 1, endLine: 3 }],
    });
    expect(prepared.snippets[0]!.content).toBe("one\r\ntwo\r\nthree");
  });

  it("normalizes @./src/../src/a.ts to src/a.ts", async () => {
    const prepared = await prepare({
      snippets: [{ path: "@./src/../src/a.ts", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippets[0]!.path).toBe("src/a.ts");
    expect(prepared.snippets[0]!.content).toBe("line1");
  });

  it("supports a one-line excerpt", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 2, endLine: 2 }],
    });
    expect(prepared.snippets[0]!.content).toBe("line2");
  });

  it("supports the final line without a trailing newline", async () => {
    const prepared = await prepare({
      snippets: [{ path: "multi.txt", startLine: 3, endLine: 3 }],
    });
    expect(prepared.snippets[0]!.content).toBe("gamma");
  });

  it("rejects absolute paths", async () => {
    const prepared = await prepare({
      snippets: [{ path: "/etc/passwd", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-path");
    expect(prepared.snippetProblems[0]!.snippet).toMatchObject({ path: "/etc/passwd" });
  });

  it("rejects lexical ../ escapes", async () => {
    const prepared = await prepare({
      snippets: [{ path: "../outside.ts", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-path");
  });

  it("rejects symlink escapes after realpath", async () => {
    const prepared = await prepare({
      snippets: [{ path: "link.ts", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-path");
  });

  it("reports a missing file", async () => {
    const prepared = await prepare({
      snippets: [{ path: "nope.ts", startLine: 1, endLine: 1 }],
    });
    const problem = prepared.snippetProblems[0]!;
    expect(problem.kind).toBe("missing");
    expect(problem.snippet).toMatchObject({ path: "nope.ts", startLine: 1, endLine: 1 });
  });

  it("reports a directory as not-a-file", async () => {
    const prepared = await prepare({
      snippets: [{ path: "subdir", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("not-file");
  });

  it("reports binary content as unsupported", async () => {
    const prepared = await prepare({
      snippets: [{ path: "binary.bin", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("unsupported");
  });

  it("reports invalid UTF-8 as unsupported", async () => {
    const prepared = await prepare({
      snippets: [{ path: "bad-utf8.txt", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("unsupported");
  });

  it("rejects reversed ranges (start > end)", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 3, endLine: 2 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-range");
  });

  it("rejects line zero defensively", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 0, endLine: 2 }],
    });
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-range");
  });

  it("rejects end lines beyond EOF without clamping", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 1, endLine: 99 }],
    });
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-range");
  });
});

describe("prepareContextHandoff — deduplication and identity", () => {
  beforeEach(seedFiles);

  it("collapses canonical identical ranges into one prepared snippet with a warning", async () => {
    const prepared = await prepare({
      snippets: [
        { path: "src/a.ts", startLine: 2, endLine: 3 },
        { path: "./src/a.ts", startLine: 2, endLine: 3 },
      ],
    });
    expect(prepared.snippets).toHaveLength(1);
    expect(prepared.warnings.some((w) => w.includes("Duplicate snippet"))).toBe(true);
  });

  it("keeps overlapping ranges separate and independently removable", async () => {
    const prepared = await prepare({
      snippets: [
        { path: "src/a.ts", startLine: 2, endLine: 3 },
        { path: "src/a.ts", startLine: 3, endLine: 4 },
      ],
    });
    expect(prepared.snippets).toHaveLength(2);
    expect(prepared.snippets[0]!.id).not.toBe(prepared.snippets[1]!.id);
  });

  it("keeps same-file ranges with different reasons separate when ranges differ", async () => {
    const prepared = await prepare({
      snippets: [
        { path: "src/a.ts", startLine: 1, endLine: 1, reason: "first" },
        { path: "src/a.ts", startLine: 2, endLine: 2, reason: "second" },
      ],
    });
    expect(prepared.snippets).toHaveLength(2);
  });

  it("normalizes and deduplicates recommended files", async () => {
    const prepared = await prepare({
      recommendedFiles: [
        { path: "src/a.ts", symbol: "frob" },
        { path: "./src/a.ts", symbol: "frob" },
      ],
    });
    expect(prepared.recommendedFiles).toHaveLength(1);
    expect(prepared.warnings.some((w) => w.includes("Duplicate recommended file"))).toBe(true);
  });

  it("does not read recommended file contents", async () => {
    const prepared = await prepare({
      recommendedFiles: [{ path: "src/a.ts" }],
    });
    const lead = prepared.recommendedFiles[0]!;
    expect("content" in lead).toBe(false);
    expect(lead.path).toBe("src/a.ts");
    // A missing lead is only existence-checked.
    const missing = await prepare({
      recommendedFiles: [{ path: "missing-lead.ts" }],
    });
    expect(missing.leadProblems[0]!.kind).toBe("missing");
  });

  it("assigns deterministic ids that survive re-preparation and index shifts", async () => {
    const first = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 2, endLine: 3 }],
    });
    const second = await prepare({
      snippets: [
        { path: "./src/a.ts", startLine: 4, endLine: 4 },
        { path: "src/a.ts", startLine: 2, endLine: 3 },
      ],
    });
    expect(second.snippets[1]!.id).toBe(first.snippets[0]!.id);
  });
});

describe("prepareContextHandoff — size enforcement", () => {
  beforeEach(seedFiles);

  const TINY_LIMITS: ContextHandoffLimits = {
    maxSnippets: 3,
    maxRecommendedFiles: 3,
    maxLinesPerSnippet: 2,
    maxBytesPerSnippet: 16,
    maxPacketTokens: 5, // 3 one-line excerpts (2 tokens each) exceed this
  };

  it("flags a snippet exceeding the line limit as oversized", async () => {
    const prepared = await prepare(
      { snippets: [{ path: "src/a.ts", startLine: 1, endLine: 3 }] },
      TINY_LIMITS,
    );
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems[0]!.kind).toBe("oversized");
  });

  it("flags a short snippet exceeding the byte limit as oversized", async () => {
    writeFileSync(join(work, "long-line.txt"), "x".repeat(100) + "\n");
    const prepared = await prepare(
      { snippets: [{ path: "long-line.txt", startLine: 1, endLine: 1 }] },
      TINY_LIMITS,
    );
    expect(prepared.snippetProblems[0]!.kind).toBe("oversized");
  });

  it("accepts excerpts exactly at the limits", async () => {
    writeFileSync(join(work, "exact.txt"), "1234567890123456\n");
    const prepared = await prepare(
      { snippets: [{ path: "exact.txt", startLine: 1, endLine: 1 }] },
      {
        ...TINY_LIMITS,
        maxLinesPerSnippet: 1,
        maxBytesPerSnippet: 16,
        // Budget the serialized packet (markers included), so give generous
        // headroom for the marker/rationale overhead of a single snippet.
        maxPacketTokens: 500,
      },
    );
    expect(prepared.snippets).toHaveLength(1);
    expect(prepared.snippetProblems).toHaveLength(0);
    expect(prepared.packetProblems).toHaveLength(0);
  });

  it("flags a packet exceeding the total token budget", async () => {
    const prepared = await prepare(
      {
        snippets: [
          { path: "src/a.ts", startLine: 1, endLine: 1 },
          { path: "src/a.ts", startLine: 2, endLine: 2 },
          { path: "src/a.ts", startLine: 3, endLine: 3 },
        ],
      },
      TINY_LIMITS,
    );
    // Each one-line excerpt ≈ 2 tokens; 3 × 2 = 6 > maxPacketTokens 5.
    expect(prepared.snippets).toHaveLength(3);
    expect(prepared.packetProblems.some((p) => p.kind === "too-large")).toBe(true);
  });

  it("flags excess snippet and lead counts as too-many packet problems", async () => {
    const prepared = await prepare(
      {
        snippets: [
          { path: "src/a.ts", startLine: 1, endLine: 1 },
          { path: "src/a.ts", startLine: 2, endLine: 2 },
          { path: "src/a.ts", startLine: 3, endLine: 3 },
          { path: "src/a.ts", startLine: 4, endLine: 4 },
        ],
        recommendedFiles: [
          { path: "a" }, { path: "b" }, { path: "c" }, { path: "d" },
        ],
      },
      TINY_LIMITS,
    );
    expect(prepared.packetProblems.some((p) => p.kind === "too-many" && p.message.includes("snippets"))).toBe(true);
    expect(prepared.packetProblems.some((p) => p.kind === "too-many" && p.message.includes("recommended files"))).toBe(true);
  });

  it("recomputes the packet when removal brings it under budget", async () => {
    // The budget boundary is derived from the SERIALIZED estimates so the
    // assertion holds regardless of marker formatting: three snippets exceed
    // it, two snippets fit.
    const refs = [
      { path: "src/a.ts", startLine: 1, endLine: 1 },
      { path: "src/a.ts", startLine: 2, endLine: 2 },
      { path: "src/a.ts", startLine: 3, endLine: 3 },
    ];
    const base = { ...TINY_LIMITS, maxLinesPerSnippet: 1, maxBytesPerSnippet: 64_000 };
    const prepared = await prepare({ snippets: refs }, { ...base, maxPacketTokens: 1_000_000 });
    expect(prepared.packetProblems).toHaveLength(0);
    const fullEstimate = estimateTokens(serializeContextHandoff(prepared).content);
    const budget = Math.max(1, fullEstimate - 1); // 3 snippets just over the limit

    const strict = await prepare({ snippets: refs }, { ...base, maxPacketTokens: budget });
    expect(strict.packetProblems.some((p) => p.kind === "too-large")).toBe(true);

    const reduced = reducePreparedContext(
      strict,
      new Set([strict.snippets[0]!.id]),
      { ...base, maxPacketTokens: budget },
    );
    expect(reduced.snippets).toHaveLength(2);
    expect(reduced.packetProblems.filter((p) => p.kind === "too-large")).toHaveLength(0);
    expect(reduced.estimatedTokens).toBeLessThan(fullEstimate);
  });

  it("measures multibyte UTF-8 in bytes, not characters", async () => {
    writeFileSync(join(work, "unicode.txt"), "héllo wörld\n"); // 13 bytes, 11 chars
    const prepared = await prepare(
      { snippets: [{ path: "unicode.txt", startLine: 1, endLine: 1 }] },
      { ...TINY_LIMITS, maxBytesPerSnippet: 12, maxLinesPerSnippet: 1 },
    );
    // 11 characters would fit a char-based check; 13 bytes trips the byte check.
    expect(prepared.snippetProblems[0]!.kind).toBe("oversized");
  });
});

describe("metadata bounds (reason / symbol)", () => {
  beforeEach(seedFiles);

  it("rejects a snippet whose reason exceeds the 200-char cap", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "x".repeat(300_000) }],
    });
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems).toHaveLength(1);
    expect(prepared.snippetProblems[0]!.message.toLowerCase()).toContain("reason");
  });

  it("accepts a reason within the 200-char cap", async () => {
    const prepared = await prepare({
      snippets: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "y".repeat(200) }],
    });
    expect(prepared.snippets).toHaveLength(1);
    expect(prepared.snippetProblems).toHaveLength(0);
  });

  it("rejects a recommended file whose symbol or reason exceeds the caps", async () => {
    const prepared = await prepare({
      recommendedFiles: [
        { path: "src/a.ts", symbol: "s".repeat(121) },
        { path: "multi.txt", reason: "r".repeat(201) },
      ],
    });
    expect(prepared.recommendedFiles).toHaveLength(0);
    expect(prepared.leadProblems).toHaveLength(2);
  });
});

describe("packet budget counts serialized overhead", () => {
  beforeEach(seedFiles);

  it("flags too-large when rationale and markers push the serialized estimate over the limit", async () => {
    // Raw excerpt is ~2 tokens; the reason + markers push the serialized
    // packet over a 12-token budget. The raw-only estimate must NOT pass.
    const limits: ContextHandoffLimits = {
      maxSnippets: 12,
      maxRecommendedFiles: 12,
      maxLinesPerSnippet: 1,
      maxBytesPerSnippet: 64_000,
      maxPacketTokens: 12,
    };
    const prepared = await prepare(
      {
        snippets: [
          { path: "src/a.ts", startLine: 1, endLine: 1, reason: "r".repeat(200) },
        ],
      },
      limits,
    );
    expect(prepared.snippets).toHaveLength(1);
    expect(prepared.packetProblems.some((p) => p.kind === "too-large")).toBe(true);
  });

  it("budgets lead lines and rationale inside maxPacketTokens", async () => {
    const limits: ContextHandoffLimits = {
      maxSnippets: 12,
      maxRecommendedFiles: 12,
      maxLinesPerSnippet: 1,
      maxBytesPerSnippet: 64_000,
      maxPacketTokens: 60,
    };
    const prepared = await prepare(
      {
        snippets: [{ path: "src/a.ts", startLine: 1, endLine: 1, reason: "r".repeat(150) }],
        recommendedFiles: [{ path: "multi.txt", reason: "q".repeat(150) }],
      },
      limits,
    );
    expect(prepared.packetProblems.some((p) => p.kind === "too-large")).toBe(true);
  });
});

describe("proposal rejects an empty '@' path", () => {
  beforeEach(seedFiles);

  it("rejects '@' as a snippet path", async () => {
    const prepared = await prepare({
      snippets: [{ path: "@", startLine: 1, endLine: 1 }],
    });
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems[0]!.kind).toBe("invalid-path");
  });

  it("rejects '@' as a recommended-file path instead of resolving the root", async () => {
    const prepared = await prepare({
      recommendedFiles: [{ path: "@" }],
    });
    expect(prepared.recommendedFiles).toHaveLength(0);
    expect(prepared.leadProblems[0]!.kind).toBe("invalid-path");
  });
});

describe("removal recomputes too-many packet problems", () => {
  beforeEach(seedFiles);

  it("drops the too-many problem once removal brings the count under the limit", async () => {
    const limits: ContextHandoffLimits = {
      maxSnippets: 12,
      maxRecommendedFiles: 12,
      maxLinesPerSnippet: 1,
      maxBytesPerSnippet: 64_000,
      maxPacketTokens: 1_000_000, // keep the token budget out of this assertion
    };
    writeFileSync(join(work, "many.txt"), Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n");
    const refs = Array.from({ length: 13 }, (_, i) => ({
      path: "many.txt",
      startLine: i + 1,
      endLine: i + 1,
    }));
    const prepared = await prepare({ snippets: refs }, limits);
    expect(prepared.snippets).toHaveLength(13);
    expect(prepared.packetProblems.some((p) => p.kind === "too-many" && p.message.includes("snippets"))).toBe(true);

    const reduced = reducePreparedContext(prepared, new Set([prepared.snippets[0]!.id]), limits);
    expect(reduced.snippets).toHaveLength(12);
    expect(reduced.packetProblems.filter((p) => p.kind === "too-many")).toHaveLength(0);
  });
});

describe("git-head source kind (worktree approval shows HEAD content)", () => {
  let repo: string;
  beforeEach(() => {
    repo = initGitRepo();
  });
  afterEach(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("prepares committed content for git-head, not the dirty working tree", async () => {
    const prepared = await prepareContextHandoff(
      { snippets: [{ path: "a.ts", startLine: 1, endLine: 2 }] },
      { sourceRoot: repo, sourceKind: "git-head" },
    );
    expect(prepared.snippets[0]!.content).toBe("committed1\ncommitted2");
    expect(prepared.snippets[0]!.content).not.toContain("DIRTY");
  });

  it("still reads the dirty working tree for the default working-tree kind", async () => {
    const prepared = await prepareContextHandoff(
      { snippets: [{ path: "a.ts", startLine: 1, endLine: 1 }] },
      { sourceRoot: repo },
    );
    expect(prepared.snippets[0]!.content).toBe("DIRTY1");
  });

  it("reports untracked files as missing for git-head", async () => {
    const prepared = await prepareContextHandoff(
      { snippets: [{ path: "untracked.ts", startLine: 1, endLine: 1 }] },
      { sourceRoot: repo, sourceKind: "git-head" },
    );
    expect(prepared.snippets).toHaveLength(0);
    expect(prepared.snippetProblems[0]!.kind).toBe("missing");
  });

  it("existence-checks recommended files against HEAD", async () => {
    const prepared = await prepareContextHandoff(
      { recommendedFiles: [{ path: "untracked.ts" }] },
      { sourceRoot: repo, sourceKind: "git-head" },
    );
    expect(prepared.recommendedFiles).toHaveLength(0);
    expect(prepared.leadProblems[0]!.kind).toBe("missing");
  });

  it("R01 — git-head content matches the CHECKOUT-FILTERED bytes the worktree will contain", async () => {
    // eol=crlf transforms the LF blob at checkout; approval must hash and
    // show those filtered bytes so freshness against the worktree passes and
    // the child sees exactly what was approved.
    writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
    writeFileSync(join(repo, "data.txt"), "one\ntwo\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "crlf attr"], { cwd: repo, stdio: "pipe" });

    const prepared = await prepareContextHandoff(
      { snippets: [{ path: "data.txt", startLine: 1, endLine: 2 }] },
      { sourceRoot: repo, sourceKind: "git-head" },
    );
    // The approved excerpt carries the checkout-filtered CRLF bytes.
    expect(prepared.snippets[0]!.content).toBe("one\r\ntwo");

    // A real worktree checkout of the same commit must hash identically.
    const wt = mkdtempSync(join(tmpdir(), "olive-r01-wt-"));
    execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: repo, stdio: "pipe" });
    try {
      const worktreeBytes = readFileSync(join(wt, "data.txt"), "utf8");
      expect(worktreeBytes).toBe("one\r\ntwo\r\n");
      // Freshness-style re-hash of the checked-out file matches the approved hash.
      const { verifyHandoffFreshness } = await import("../src/handoff/freshness.js");
      const { serializeContextHandoff } = await import("../src/handoff/serialize.js");
      const failures = await verifyHandoffFreshness(serializeContextHandoff(prepared), wt);
      expect(failures).toEqual([]);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: "pipe" });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

/** Create a temp git repo with a committed a.ts, then a dirty uncommitted edit. */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "olive-handoff-git-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "a.ts"), "committed1\ncommitted2\ncommitted3\n");
  writeFileSync(join(dir, "untracked.ts"), "new\n");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "a.ts"), "DIRTY1\ncommitted2\ncommitted3\n");
  return dir;
}