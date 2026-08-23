/**
 * handoff/prepare.ts — Resolve a proposed context packet before human review.
 *
 * References are lexically normalized and deduplicated (identical canonical
 * ranges are collapsed with a warning; overlapping ranges stay separate so
 * each remains independently removable), resolved to exact source lines by a
 * bounded source reader, size-checked against per-snippet and total-packet
 * limits, and hashed whole-source for launch-time freshness verification.
 *
 * The packet token budget is computed over the SERIALIZED packet (markers,
 * rationale, and lead lines included), so oversized metadata can never slip
 * past a tiny excerpt. Nothing is repaired: invalid, missing, unsupported,
 * oversized, or over-long references surface as problems the human can remove
 * or the main agent can re-propose.
 */

import {
  DEFAULT_CONTEXT_HANDOFF_LIMITS,
  MAX_REASON_CHARS,
  MAX_SYMBOL_CHARS,
  type ContextHandoffLimits,
  type ContextHandoffProposal,
  type ContextLeadRef,
  type ContextProblem,
  type ContextProblemKind,
  type ContextSnippetRef,
  type ContextSourceReader,
  type PreparedContextHandoff,
  type PreparedLead,
  type PreparedSnippet,
  type SourceKind,
} from "./types.js";
import {
  estimateTokens,
  normalizeLexicalPath,
  readerFor,
  sha256Hex,
  type LexicalPath,
} from "./source.js";
import { serializeContextHandoff } from "./serialize.js";

export interface PrepareContextOptions {
  /** Root against which references are normalized and contained. */
  sourceRoot: string;
  /** Where to resolve evidence from. Defaults to the working tree. */
  sourceKind?: SourceKind;
  limits?: ContextHandoffLimits;
  /** Injectable reader (tests observe memory bounds / substitute git). */
  reader?: ContextSourceReader;
}

/** Deterministic id: derived from normalized identity, never array position. */
function snippetId(path: string, startLine: number, endLine: number): string {
  return sha256Hex(`${path}:${startLine}:${endLine}`).slice(0, 12);
}

function leadId(path: string, symbol: string | undefined): string {
  return sha256Hex(`${path}:${symbol ?? ""}`).slice(0, 12);
}

/** Serialized-token estimate of a resolved packet (rationale + markers + leads). */
function serializedEstimate(packet: Pick<PreparedContextHandoff, "snippets" | "recommendedFiles">): number {
  const temp: PreparedContextHandoff = {
    version: 1,
    snippets: packet.snippets,
    recommendedFiles: packet.recommendedFiles,
    snippetProblems: [],
    leadProblems: [],
    packetProblems: [],
    warnings: [],
    totalBytes: 0,
    estimatedTokens: 0,
  };
  return estimateTokens(serializeContextHandoff(temp).content);
}

/** Resolve one proposal into an exact, attributable, bounded packet. */
export async function prepareContextHandoff(
  proposal: ContextHandoffProposal,
  options: PrepareContextOptions,
): Promise<PreparedContextHandoff> {
  const limits = options.limits ?? DEFAULT_CONTEXT_HANDOFF_LIMITS;
  const reader: ContextSourceReader = options.reader ?? readerFor(options.sourceKind ?? "working-tree");
  const warnings: string[] = [];
  const snippetProblems: ContextProblem[] = [];
  const leadProblems: ContextProblem[] = [];
  const packetProblems: ContextProblem[] = [];
  const snippets: PreparedSnippet[] = [];
  const recommendedFiles: PreparedLead[] = [];

  if (proposal.snippets !== undefined && !Array.isArray(proposal.snippets)) {
    snippetProblems.push({
      id: "packet-snippets",
      kind: "invalid-path",
      message: "snippets must be an array of snippet references.",
    });
  }
  if (
    proposal.recommendedFiles !== undefined &&
    !Array.isArray(proposal.recommendedFiles)
  ) {
    leadProblems.push({
      id: "packet-leads",
      kind: "invalid-path",
      message: "recommendedFiles must be an array of lead references.",
    });
  }

  const snippetRefs = Array.isArray(proposal.snippets) ? proposal.snippets : [];
  const leadRefs = Array.isArray(proposal.recommendedFiles)
    ? proposal.recommendedFiles
    : [];

  if (snippetRefs.length > limits.maxSnippets) {
    packetProblems.push({
      id: "packet-too-many-snippets",
      kind: "too-many",
      message: `Proposal has ${snippetRefs.length} snippets; the limit is ${limits.maxSnippets}. Reduce the snippets and retry.`,
    });
  }
  if (leadRefs.length > limits.maxRecommendedFiles) {
    packetProblems.push({
      id: "packet-too-many-leads",
      kind: "too-many",
      message: `Proposal has ${leadRefs.length} recommended files; the limit is ${limits.maxRecommendedFiles}. Reduce the recommended files and retry.`,
    });
  }

  // ---- Snippets ----
  const seen = new Map<string, ContextSnippetRef>();
  for (const ref of snippetRefs) {
    if (
      !ref ||
      typeof ref.path !== "string" ||
      !Number.isInteger(ref.startLine) ||
      !Number.isInteger(ref.endLine)
    ) {
      snippetProblems.push({
        id: `snippet-${snippetProblems.length}`,
        kind: "invalid-range",
        message: "Snippet must include a path and integer start_line and end_line.",
        snippet: ref,
      });
      continue;
    }
    if (ref.startLine < 1 || ref.endLine < ref.startLine) {
      snippetProblems.push({
        id: snippetId(ref.path, ref.startLine, ref.endLine),
        kind: "invalid-range",
        message: `Invalid line range ${ref.startLine}-${ref.endLine}: ranges are 1-indexed, inclusive, and start must not exceed end.`,
        snippet: ref,
      });
      continue;
    }
    if (ref.reason !== undefined && ref.reason.length > MAX_REASON_CHARS) {
      snippetProblems.push({
        id: snippetId(ref.path, ref.startLine, ref.endLine),
        kind: "oversized",
        message: `Snippet reason exceeds the ${MAX_REASON_CHARS}-character cap. Shorten the rationale or omit it.`,
        snippet: ref,
      });
      continue;
    }

    let resolved: LexicalPath;
    try {
      resolved = normalizeLexicalPath(ref.path, options.sourceRoot);
    } catch (error) {
      snippetProblems.push(problemFromError(ref, error));
      continue;
    }

    const seenKey = `${resolved.path}|${ref.startLine}|${ref.endLine}`;
    if (seen.has(seenKey)) {
      warnings.push(`Duplicate snippet ignored: ${resolved.path}:${ref.startLine}-${ref.endLine}`);
      continue;
    }
    seen.set(seenKey, ref);

    // Line-count cap is checked before any read — a huge range never touches disk.
    const lineCount = ref.endLine - ref.startLine + 1;
    if (lineCount > limits.maxLinesPerSnippet) {
      snippetProblems.push({
        id: snippetId(resolved.path, ref.startLine, ref.endLine),
        kind: "oversized",
        message: `Excerpt is ${lineCount} lines; the limit is ${limits.maxLinesPerSnippet} lines. Select a smaller range.`,
        snippet: ref,
      });
      continue;
    }

    let file;
    try {
      file = await reader.readRange({
        sourceRoot: options.sourceRoot,
        relativePath: resolved.path,
        startLine: ref.startLine,
        endLine: ref.endLine,
        maxExcerptBytes: limits.maxBytesPerSnippet,
      });
    } catch (error) {
      snippetProblems.push(problemFromError(ref, error));
      continue;
    }

    snippets.push({
      id: snippetId(resolved.path, ref.startLine, ref.endLine),
      path: resolved.path,
      absolutePath: resolved.absolutePath,
      startLine: ref.startLine,
      endLine: ref.endLine,
      content: file.content,
      bytes: file.bytes,
      estimatedTokens: estimateTokens(file.content),
      sourceHash: file.sourceHash,
      reason: ref.reason,
    });
  }

  // ---- Recommended files (leads are existence-checked, never read) ----
  const seenLeads = new Map<string, ContextLeadRef>();
  for (const ref of leadRefs) {
    if (!ref || typeof ref.path !== "string") {
      leadProblems.push({
        id: `lead-${leadProblems.length}`,
        kind: "invalid-path",
        message: "Recommended file must include a path.",
        lead: ref,
      });
      continue;
    }
    if (ref.symbol !== undefined && ref.symbol.length > MAX_SYMBOL_CHARS) {
      leadProblems.push({
        id: leadId(ref.path, ref.symbol),
        kind: "oversized",
        message: `Recommended-file symbol exceeds the ${MAX_SYMBOL_CHARS}-character cap.`,
        lead: ref,
      });
      continue;
    }
    if (ref.reason !== undefined && ref.reason.length > MAX_REASON_CHARS) {
      leadProblems.push({
        id: leadId(ref.path, ref.symbol),
        kind: "oversized",
        message: `Recommended-file reason exceeds the ${MAX_REASON_CHARS}-character cap.`,
        lead: ref,
      });
      continue;
    }

    let resolved: LexicalPath;
    try {
      resolved = normalizeLexicalPath(ref.path, options.sourceRoot);
    } catch (error) {
      leadProblems.push(problemFromError(ref, error));
      continue;
    }

    const seenKey = `${resolved.path}|${ref.symbol ?? ""}`;
    if (seenLeads.has(seenKey)) {
      warnings.push(
        `Duplicate recommended file ignored: ${resolved.path}${ref.symbol ? ` (${ref.symbol})` : ""}`,
      );
      continue;
    }
    seenLeads.set(seenKey, ref);

    let info;
    try {
      info = await reader.checkExistence({
        sourceRoot: options.sourceRoot,
        relativePath: resolved.path,
      });
    } catch (error) {
      leadProblems.push(problemFromError(ref, error));
      continue;
    }
    if (!info.exists) {
      leadProblems.push({
        id: leadId(resolved.path, ref.symbol),
        kind: "missing",
        message: `Recommended file does not exist: ${resolved.path}`,
        lead: ref,
      });
      continue;
    }
    if (!info.isFile && !info.isDirectory) {
      leadProblems.push({
        id: leadId(resolved.path, ref.symbol),
        kind: "not-file",
        message: `Recommended path is not a file or directory: ${resolved.path}`,
        lead: ref,
      });
      continue;
    }

    recommendedFiles.push({
      id: leadId(resolved.path, ref.symbol),
      path: resolved.path,
      symbol: ref.symbol,
      reason: ref.reason,
    });
  }

  const totalBytes = snippets.reduce((sum, s) => sum + s.bytes, 0);
  const estimatedTokens = serializedEstimate({ snippets, recommendedFiles });
  if (estimatedTokens > limits.maxPacketTokens) {
    packetProblems.push({
      id: "packet-too-large",
      kind: "too-large",
      message: `Packet is estimated at ${estimatedTokens} tokens; the limit is ${limits.maxPacketTokens}. Remove snippets or select smaller ranges.`,
    });
  }

  return {
    version: 1,
    snippets,
    recommendedFiles,
    snippetProblems,
    leadProblems,
    packetProblems,
    warnings,
    totalBytes,
    estimatedTokens,
  };
}

/**
 * Human removal during review: drop the given ids and recompute totals and all
 * packet-level problems (count overflows AND the total-token budget) against
 * the surviving entries, so a removal can never leave a stale blocking error.
 * Remaining entries are copied, never mutated.
 */
export function reducePreparedContext(
  prepared: PreparedContextHandoff,
  removedIds: ReadonlySet<string>,
  limits: ContextHandoffLimits = DEFAULT_CONTEXT_HANDOFF_LIMITS,
): PreparedContextHandoff {
  const snippets = prepared.snippets.filter((s) => !removedIds.has(s.id));
  const recommendedFiles = prepared.recommendedFiles.filter(
    (l) => !removedIds.has(l.id),
  );
  const snippetProblems = prepared.snippetProblems.filter(
    (p) => !removedIds.has(p.id),
  );
  const leadProblems = prepared.leadProblems.filter((p) => !removedIds.has(p.id));
  const totalBytes = snippets.reduce((sum, s) => sum + s.bytes, 0);
  const estimatedTokens = serializedEstimate({ snippets, recommendedFiles });

  const packetProblems: ContextProblem[] = [];
  if (snippets.length > limits.maxSnippets) {
    packetProblems.push({
      id: "packet-too-many-snippets",
      kind: "too-many",
      message: `${snippets.length} snippets remain; the limit is ${limits.maxSnippets}. Remove more before launching.`,
    });
  }
  if (recommendedFiles.length > limits.maxRecommendedFiles) {
    packetProblems.push({
      id: "packet-too-many-leads",
      kind: "too-many",
      message: `${recommendedFiles.length} recommended files remain; the limit is ${limits.maxRecommendedFiles}. Remove more before launching.`,
    });
  }
  if (estimatedTokens > limits.maxPacketTokens) {
    packetProblems.push({
      id: "packet-too-large",
      kind: "too-large",
      message: `Packet is estimated at ${estimatedTokens} tokens; the limit is ${limits.maxPacketTokens}. Remove snippets or select smaller ranges.`,
    });
  }

  return {
    ...prepared,
    snippets,
    recommendedFiles,
    snippetProblems,
    leadProblems,
    packetProblems,
    totalBytes,
    estimatedTokens,
  };
}

function problemFromError(ref: ContextSnippetRef | ContextLeadRef, error: unknown): ContextProblem {
  const kind = error instanceof Error && "kind" in error
    ? (error as { kind: ContextProblemKind }).kind
    : "unreadable";
  const message =
    error instanceof Error
      ? error.message
      : String(error);
  const base = { kind, message };
  if ("startLine" in ref) {
    return { ...base, id: snippetId(ref.path, ref.startLine, ref.endLine), snippet: ref };
  }
  return { ...base, id: leadId(ref.path, ref.symbol), lead: ref };
}