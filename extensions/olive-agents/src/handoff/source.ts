/**
 * handoff/source.ts — Source-tree primitives for constrained context.
 *
 * Model-authored path strings are never trusted. References are lexically
 * normalized (one leading `@` stripped, `.`/`..` resolved, empty rejected),
 * containment-checked, and read through bounded streaming readers that keep
 * only the requested excerpt in memory while still hashing the full source.
 *
 * Working-tree reads re-canonicalize at read time (closing the missing-target
 * symlink TOCTOU: a path validated while its symlink target is absent is
 * re-checked through realpath before the bytes are read). Git-HEAD reads
 * resolve against the child's seed commit for worktree launches, so approval
 * shows the exact content the child will see — never dirty parent edits.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import type { ContextProblemKind, ContextSourceReader, ReadRangeInput } from "./types.js";

export interface LexicalPath {
  /** Normalized project-relative, `/`-separated path. */
  path: string;
  /** Absolute path (lexical — symlinks not resolved here). */
  absolutePath: string;
}

/** Thrown for any reference-resolution failure; carries the problem kind. */
export class ContextPathError extends Error {
  constructor(
    public readonly kind: ContextProblemKind,
    message: string,
  ) {
    super(message);
  }
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Lexically normalize one model-authored path reference against the source
 * root. Accepts relative paths (one leading `@` stripped), resolves `.`/`..`
 * segments, and rejects empty paths (including a bare `@`), absolute paths,
 * and lexical escapes. No filesystem access — readers enforce containment at
 * read time.
 */
export function normalizeLexicalPath(rawPath: string, sourceRoot: string): LexicalPath {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new ContextPathError("invalid-path", "Path reference is empty.");
  }
  const trimmed = rawPath.trim();
  const cleaned = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!cleaned.trim()) {
    throw new ContextPathError(
      "invalid-path",
      "Path reference is empty after '@'.",
    );
  }
  const absolutePath = path.resolve(sourceRoot, cleaned);
  const relative = path.relative(sourceRoot, absolutePath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ContextPathError(
      "invalid-path",
      `Path escapes the source root: ${rawPath}`,
    );
  }
  return { path: relative.split(path.sep).join("/"), absolutePath };
}

/** Coarse, deterministic token estimate (1 token ≈ 4 characters). */
export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Errors thrown by any source reader. */
export type { ContextProblemKind };

// ---- Working-tree reader ----

/** Canonicalize a contained path, re-checking containment at read time. */
async function canonicalizeContained(sourceRoot: string, relativePath: string): Promise<string> {
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([
      realpath(sourceRoot),
      realpath(path.join(sourceRoot, relativePath)),
    ]);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new ContextPathError("missing", "File does not exist.");
    }
    throw new ContextPathError(
      "unreadable",
      `Cannot resolve path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isInside(realTarget, realRoot)) {
    throw new ContextPathError(
      "invalid-path",
      "Resolved path is outside the source root.",
    );
  }
  return realTarget;
}

async function statRegularFile(absolutePath: string): Promise<void> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new ContextPathError("missing", "File does not exist.");
    }
    throw new ContextPathError(
      "unreadable",
      `Cannot stat file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isFile()) {
    throw new ContextPathError("not-file", "Path is not a regular file.");
  }
}

interface ExcerptRange {
  startLine: number;
  endLine: number;
  maxExcerptBytes: number;
}

/**
 * Consume a byte stream once: hash the full content (whole-source sha256),
 * validate binary (NUL) and UTF-8 across the whole stream, and retain only the
 * requested line span in memory. Early-aborts as soon as the retained span
 * exceeds `maxExcerptBytes`; reports `invalid-range` when EOF arrives before
 * the requested lines. Content bytes = the retained excerpt bytes.
 */
function digestStream(
  stream: Readable,
  range: ExcerptRange,
): Promise<{ content: string; bytes: number; sourceHash: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const captured: string[] = [];
    let currentLine = 0; // line currently being built (1-indexed)
    let currentText = "";
    let spanBytes = 0;
    let lastCapturedTerminated = false; // last captured line ended with a newline
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };

    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      hash.update(chunk);
      if (chunk.includes(0)) {
        fail(new ContextPathError("unsupported", "Binary content is not supported."));
        return;
      }
      let text: string;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch {
        fail(new ContextPathError("unsupported", "Content is not valid UTF-8 text."));
        return;
      }
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
          const lineNumber = currentLine + 1; // the line being completed
          if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
            captured.push(currentText);
            lastCapturedTerminated = true;
            spanBytes += Buffer.byteLength(currentText, "utf8");
            if (spanBytes > range.maxExcerptBytes) {
              fail(new ContextPathError(
                "oversized",
                `Excerpt exceeds ${range.maxExcerptBytes} bytes.`,
              ));
              return;
            }
          }
          currentLine++;
          currentText = "";
        } else {
          const lineNumber = currentLine + 1; // the line being built
          if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
            currentText += text[i];
          }
        }
        // Text outside the requested span is discarded immediately, so peak
        // memory stays bounded to the excerpt (+ one line + one chunk).
      }
    });

    stream.on("end", () => {
      if (settled) return;
      try {
        const tail = decoder.decode(); // flush pending multibyte; fatal errors surface
        const finalLine = tail + currentText;
        if (finalLine.length > 0) {
          const lineNumber = currentLine + 1; // pending final line
          if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
            captured.push(finalLine);
            lastCapturedTerminated = false; // not newline-terminated at EOF
            spanBytes += Buffer.byteLength(finalLine, "utf8");
            if (spanBytes > range.maxExcerptBytes) {
              fail(new ContextPathError(
                "oversized",
                `Excerpt exceeds ${range.maxExcerptBytes} bytes.`,
              ));
              return;
            }
          }
          currentLine++;
        }
        if (currentLine < range.startLine || currentLine < range.endLine) {
          fail(new ContextPathError(
            "invalid-range",
            `Range ${range.startLine}-${range.endLine} is outside the file (${currentLine} lines).`,
          ));
          return;
        }
        // Drop the final line's full terminator ("\r\n" leaves the raw "\r"
        // on the captured text) so the excerpt matches the reviewed slice with
        // no dangling line ending.
        if (captured.length > 0 && lastCapturedTerminated) {
          const last = captured[captured.length - 1]!;
          if (last.endsWith("\r")) {
            captured[captured.length - 1] = last.slice(0, -1);
            spanBytes = Math.max(0, spanBytes - 1);
          }
        }
        const content = captured.join("\n");
        // The in-flight span count excludes separators; enforce the cap on the
        // actual joined excerpt so a multi-line snippet cannot exceed it.
        if (Buffer.byteLength(content, "utf8") > range.maxExcerptBytes) {
          fail(new ContextPathError(
            "oversized",
            `Excerpt exceeds ${range.maxExcerptBytes} bytes.`,
          ));
          return;
        }
        settled = true;
        resolve({ content, bytes: Buffer.byteLength(content, "utf8"), sourceHash: hash.digest("hex") });
      } catch {
        fail(new ContextPathError("unsupported", "Content is not valid UTF-8 text."));
      }
    });

    stream.on("error", (error: any) => {
      if (error?.code === "ENOENT") {
        fail(new ContextPathError("missing", "File does not exist."));
      } else {
        fail(new ContextPathError(
          "unreadable",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  });
}

/** Hash a whole stream without retaining content (freshness verification). */
async function digestHashOnly(stream: Readable): Promise<{ bytes: number; sourceHash: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      hash.update(chunk);
      bytes += chunk.length;
      if (chunk.includes(0)) {
        fail(new ContextPathError("unsupported", "Binary content is not supported."));
        return;
      }
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        fail(new ContextPathError("unsupported", "Content is not valid UTF-8 text."));
      }
    });
    stream.on("end", () => {
      if (settled) return;
      try {
        decoder.decode();
        settled = true;
        resolve({ bytes, sourceHash: hash.digest("hex") });
      } catch {
        fail(new ContextPathError("unsupported", "Content is not valid UTF-8 text."));
      }
    });
    stream.on("error", (error: any) => {
      if (error?.code === "ENOENT") {
        fail(new ContextPathError("missing", "File does not exist."));
      } else {
        fail(new ContextPathError(
          "unreadable",
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  });
}

export function createWorkingTreeReader(): ContextSourceReader {
  return {
    kind: "working-tree",
    async readRange(input: ReadRangeInput) {
      const absolutePath = await canonicalizeContained(input.sourceRoot, input.relativePath);
      await statRegularFile(absolutePath);
      return digestStream(createReadStream(absolutePath), {
        startLine: input.startLine,
        endLine: input.endLine,
        maxExcerptBytes: input.maxExcerptBytes,
      });
    },
    async readHash(input: { sourceRoot: string; relativePath: string }) {
      const absolutePath = await canonicalizeContained(input.sourceRoot, input.relativePath);
      await statRegularFile(absolutePath);
      return digestHashOnly(createReadStream(absolutePath));
    },
    async checkExistence(input: { sourceRoot: string; relativePath: string }) {
      const absolutePath = await canonicalizeContained(input.sourceRoot, input.relativePath);
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        return { exists: false, isFile: false, isDirectory: false };
      }
      return { exists: true, isFile: info.isFile(), isDirectory: info.isDirectory() };
    },
  };
}

// ---- Git-HEAD reader (worktree approval shows the seed commit) ----

function runGit(args: string[], cwd: string, envExt: Record<string, string> = {}): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...envExt },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (error) => {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

async function gitRepoRoot(sourceRoot: string): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], sourceRoot);
  if (result.code !== 0) {
    throw new ContextPathError(
      "invalid-path",
      "Path is not inside a git repository (required for worktree context source).",
    );
  }
  const root = result.stdout.toString("utf-8").trim();
  if (!root) throw new ContextPathError("invalid-path", "Could not resolve the git repository root.");
  return root;
}

async function repoRelativePath(repoRoot: string, sourceRoot: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(sourceRoot, relativePath);
  const repoRel = path.relative(repoRoot, absolutePath);
  if (repoRel === ".." || repoRel.startsWith(`..${path.sep}`) || path.isAbsolute(repoRel)) {
    throw new ContextPathError("invalid-path", "Path escapes the git repository root.");
  }
  return repoRel.split(path.sep).join("/");
}

/** Object type at HEAD: "blob" | "tree" | undefined (missing). */
async function gitHeadObjectType(repoRoot: string, repoRel: string): Promise<"blob" | "tree" | undefined> {
  const found = await runGit(["rev-parse", "--verify", `HEAD:${repoRel}`], repoRoot);
  if (found.code !== 0) return undefined;
  const objectId = found.stdout.toString("utf-8").trim();
  if (!objectId) return undefined;
  const typed = await runGit(["cat-file", "-t", objectId], repoRoot);
  if (typed.code !== 0) return undefined;
  const type = typed.stdout.toString("utf-8").trim();
  return type === "blob" ? "blob" : type === "tree" ? "tree" : undefined;
}

/** Read a regular file's excerpt with whole-file hash (post-containment). */
async function readRangeFromFile(
  absolutePath: string,
  range: ExcerptRange,
): Promise<{ content: string; bytes: number; sourceHash: string }> {
  await statRegularFile(absolutePath);
  return digestStream(createReadStream(absolutePath), range);
}

/**
 * Resolve the CHECKOUT-FILTERED bytes of a path at HEAD and run `fn` over
 * them as a temp file. `git cat-file` returns raw blob bytes, but smudge/eol
 * filters transform them at checkout — the child worktree contains the
 * FILTERED bytes, so approval content and its hash must match those or
 * freshness fails falsely and approval shows text the child never sees.
 * Uses a temporary index + checkout-index so the real checkout filters apply
 * without touching the parent working tree.
 */
async function withGitHeadFile<T>(
  repoRoot: string,
  repoRel: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const type = await gitHeadObjectType(repoRoot, repoRel);
  if (!type) throw new ContextPathError("missing", "Path does not exist at HEAD.");
  if (type !== "blob") throw new ContextPathError("not-file", "Path is not a regular file at HEAD.");

  const tempDir = await mkdtemp(joinInTemp("olive-githead-"));
  try {
    const indexPath = path.join(tempDir, "index");
    const outDir = path.join(tempDir, "out");
    mkdirSync(outDir, { recursive: true });
    const env = { GIT_INDEX_FILE: indexPath };
    const tree = await runGit(["read-tree", "HEAD"], repoRoot, env);
    if (tree.code !== 0) {
      throw new ContextPathError("unreadable", `git read-tree failed: ${tree.stderr.toString("utf-8").trim()}`);
    }
    const checkout = await runGit(
      ["checkout-index", "-f", "--prefix", `${outDir}/`, "--", repoRel],
      repoRoot,
      env,
    );
    if (checkout.code !== 0) {
      throw new ContextPathError("missing", `Path does not exist at HEAD: ${repoRel}`);
    }
    return await fn(path.join(outDir, repoRel));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function joinInTemp(name: string): string {
  return path.join(tmpdir(), name);
}

export function createGitHeadReader(): ContextSourceReader {
  return {
    kind: "git-head",
    async readRange(input: ReadRangeInput) {
      const repoRoot = await gitRepoRoot(input.sourceRoot);
      const repoRel = await repoRelativePath(repoRoot, input.sourceRoot, input.relativePath);
      return withGitHeadFile(repoRoot, repoRel, (filePath) =>
        readRangeFromFile(filePath, {
          startLine: input.startLine,
          endLine: input.endLine,
          maxExcerptBytes: input.maxExcerptBytes,
        }),
      );
    },
    async readHash(input: { sourceRoot: string; relativePath: string }) {
      const repoRoot = await gitRepoRoot(input.sourceRoot);
      const repoRel = await repoRelativePath(repoRoot, input.sourceRoot, input.relativePath);
      return withGitHeadFile(repoRoot, repoRel, async (filePath) => {
        await statRegularFile(filePath);
        return digestHashOnly(createReadStream(filePath));
      });
    },
    async checkExistence(input: { sourceRoot: string; relativePath: string }) {
      const repoRoot = await gitRepoRoot(input.sourceRoot);
      const repoRel = await repoRelativePath(repoRoot, input.sourceRoot, input.relativePath);
      const type = await gitHeadObjectType(repoRoot, repoRel);
      return {
        exists: type !== undefined,
        isFile: type === "blob",
        isDirectory: type === "tree",
      };
    },
  };
}

/** Reader factory for a given source kind (default: working tree). */
export function readerFor(sourceKind: "working-tree" | "git-head"): ContextSourceReader {
  return sourceKind === "git-head" ? createGitHeadReader() : createWorkingTreeReader();
}