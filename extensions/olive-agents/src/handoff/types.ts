/**
 * handoff/types.ts — Direction-neutral constrained-context contract.
 *
 * The main agent proposes *references* (paths + line ranges + reasons); Olive
 * resolves them into an exact, attributable packet that a human reviews before
 * launch. The types deliberately do not encode a sender/recipient direction:
 * the transport layer decides whether the packet goes parent→child,
 * child→parent, or elsewhere. This keeps the model usable for future
 * subagent→main handoff without a vocabulary change.
 */

/** One file-backed excerpt proposed by an agent (untrusted, reference-only). */
export interface ContextSnippetRef {
  /** Project-relative source file path. */
  path: string;
  /** First source line, 1-indexed and inclusive. */
  startLine: number;
  /** Last source line, 1-indexed and inclusive. */
  endLine: number;
  /** Parent rationale — a claim about relevance, never verified fact. */
  reason?: string;
}

/** An exploration lead: guides the child but never preloads content. */
export interface ContextLeadRef {
  /** Project-relative file or directory path. */
  path: string;
  /** Optional symbol or search target the child may want to look up. */
  symbol?: string;
  reason?: string;
}

/** The untrusted, model-authored context section of one delegation proposal. */
export interface ContextHandoffProposal {
  snippets?: ContextSnippetRef[];
  recommendedFiles?: ContextLeadRef[];
}

/** Size bounds for one prepared packet. */
export interface ContextHandoffLimits {
  maxSnippets: number;
  maxRecommendedFiles: number;
  maxLinesPerSnippet: number;
  maxBytesPerSnippet: number;
  maxPacketTokens: number;
}

/** Metadata length caps — unbounded rationale must never inflate the packet. */
export const MAX_REASON_CHARS = 200;
export const MAX_SYMBOL_CHARS = 120;

/** Where evidence is resolved from for one preparation. */
export type SourceKind = "working-tree" | "git-head";

/** Input to a source reader's bounded excerpt read. */
export interface ReadRangeInput {
  /** Root the relative path is contained in. */
  sourceRoot: string;
  /** Lexically normalized, `/`-separated project-relative path. */
  relativePath: string;
  /** 1-indexed inclusive first line. */
  startLine: number;
  /** 1-indexed inclusive last line. */
  endLine: number;
  /** Early-abort cap for the retained excerpt (bytes). */
  maxExcerptBytes: number;
}

/**
 * Source-tree access behind the prepare path. Model-authored paths are never
 * trusted: readers enforce containment at read time and keep only the excerpt
 * in memory while hashing the full source. Injectable for tests.
 */
export interface ContextSourceReader {
  kind: SourceKind;
  /** Read a bounded excerpt plus a whole-source sha256. Throws ContextPathError. */
  readRange(input: ReadRangeInput): Promise<{ content: string; bytes: number; sourceHash: string }>;
  /** Whole-source hash only (freshness verification; content discarded). */
  readHash(input: { sourceRoot: string; relativePath: string }): Promise<{ bytes: number; sourceHash: string }>;
  /** Existence + type check for leads — never reads contents. */
  checkExistence(input: { sourceRoot: string; relativePath: string }): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean }>;
}

/**
 * Agreed conservative defaults (tune after the experiential trial — not
 * per-model scaled in v1; see plan decision #1 and #6).
 */
export const DEFAULT_CONTEXT_HANDOFF_LIMITS: ContextHandoffLimits = {
  maxSnippets: 12,
  maxRecommendedFiles: 12,
  maxLinesPerSnippet: 400,
  maxBytesPerSnippet: 64_000,
  maxPacketTokens: 40_000,
};

export type ContextProblemKind =
  | "invalid-path"   // absolute path, escapes the source root, empty, malformed
  | "missing"        // file does not exist
  | "not-file"       // directory or non-regular file where a file was required
  | "unreadable"     // stat/read permission failure
  | "unsupported"    // binary or invalid UTF-8 content
  | "invalid-range"  // start > end, out of bounds, non-integer, <1
  | "oversized"      // exceeds per-snippet line or byte limit
  | "too-many"       // more references than the packet limit
  | "too-large";     // packet exceeds the total token budget

/** A failed reference. Kept visible so the human can remove it or the main
 *  agent can re-propose via the feedback channel. */
export interface ContextProblem {
  id: string;
  kind: ContextProblemKind;
  /** Human-readable explanation used in the review UI and feedback report. */
  message: string;
  /** The original snippet reference (when the problem came from a snippet). */
  snippet?: ContextSnippetRef;
  /** The original lead reference (when the problem came from a lead). */
  lead?: ContextLeadRef;
}

/** An excerpt resolved to exact file content with full provenance. */
export interface PreparedSnippet {
  /** Deterministic id derived from the normalized path + range (stable across
   *  re-preparation, immune to array index shifts). */
  id: string;
  /** Normalized project-relative, `/`-separated path. */
  path: string;
  /** Internal only — never serialized into model-facing text. */
  absolutePath: string;
  startLine: number;
  endLine: number;
  /** Exact current source text for the range (no dangling final newline). */
  content: string;
  bytes: number;
  estimatedTokens: number;
  /** Whole-file sha256 at preparation time; verified against the child's
   *  launch cwd just before the child window opens. */
  sourceHash: string;
  reason?: string;
}

/** A resolved lead (existence-checked, content never read). */
export interface PreparedLead {
  id: string;
  path: string;
  symbol?: string;
  reason?: string;
}

/** The fully resolved packet that goes through human review. Immutable once
 *  approved: review removes items via `reducePreparedContext`, never mutates
 *  the remaining entries. */
export interface PreparedContextHandoff {
  version: 1;
  snippets: PreparedSnippet[];
  recommendedFiles: PreparedLead[];
  snippetProblems: ContextProblem[];
  leadProblems: ContextProblem[];
  /** Packet-level problems (count overflow, total budget overflow). */
  packetProblems: ContextProblem[];
  /** Non-blocking notes (e.g. duplicate references collapsed). */
  warnings: string[];
  totalBytes: number;
  estimatedTokens: number;
}

/** True when nothing would be transferred and nothing failed. */
export function isContextHandoffEmpty(prepared: PreparedContextHandoff): boolean {
  return (
    prepared.snippets.length === 0 &&
    prepared.recommendedFiles.length === 0 &&
    prepared.snippetProblems.length === 0 &&
    prepared.leadProblems.length === 0 &&
    prepared.packetProblems.length === 0
  );
}

/** True when at least one item failed preparation and must be resolved before
 *  launch (either removed by the human or re-proposed by the main agent). */
export function hasContextHandoffProblems(prepared: PreparedContextHandoff): boolean {
  return (
    prepared.snippetProblems.length > 0 ||
    prepared.leadProblems.length > 0 ||
    prepared.packetProblems.length > 0
  );
}