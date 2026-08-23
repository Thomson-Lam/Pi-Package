/**
 * handoff/serialize.ts — Render the approved packet for the child session.
 *
 * Produces one model-facing `content` string (evidence with exact provenance,
 * leads without any file contents, rationale outside the evidence blocks) plus
 * a separate UI/verification `details` object. Internal metadata (absolute
 * paths, source hashes) lives only in `details`, never in model-facing text.
 */

import type { PreparedContextHandoff } from "./types.js";

export interface DeliveredContextHandoff {
  version: 1;
  /** Model-facing handoff text. Empty when the packet carries nothing. */
  content: string;
  /** UI + launch-time verification metadata (not sent as prompt content). */
  details: {
    snippets: Array<{
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      bytes: number;
      estimatedTokens: number;
      /** Whole-file sha256 — reused by the launch-time freshness check. */
      sourceHash: string;
      reason?: string;
    }>;
    recommendedFiles: Array<{
      path: string;
      symbol?: string;
      reason?: string;
    }>;
    totalBytes: number;
    estimatedTokens: number;
  };
}

const EVIDENCE_BEGIN = "===== BEGIN OLIVE EVIDENCE ";
const MARKER_END = " =====\n";
const EVIDENCE_END = "===== END OLIVE EVIDENCE =====\n";
const LEADS_BEGIN = "===== BEGIN OLIVE RECOMMENDED FILES =====\n";
const LEADS_END = "===== END OLIVE RECOMMENDED FILES =====\n";

/** Render an approved packet. The packet is opaque text for the child — it is
 *  never parsed, so marker-like content inside excerpts cannot break binding. */
export function serializeContextHandoff(
  prepared: PreparedContextHandoff,
): DeliveredContextHandoff {
  const parts: string[] = [];
  for (const snippet of prepared.snippets) {
    const meta = JSON.stringify({
      path: snippet.path,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
    });
    parts.push(
      `${EVIDENCE_BEGIN}${meta}${MARKER_END}${snippet.content}\n${EVIDENCE_END}`,
    );
    if (snippet.reason) {
      parts.push(`Rationale: ${snippet.reason}\n`);
    }
  }

  let leadsBlock = "";
  if (prepared.recommendedFiles.length > 0) {
    const leadLines = prepared.recommendedFiles.map((lead) => {
      const symbol = lead.symbol ? ` (symbol: ${lead.symbol})` : "";
      const reason = lead.reason ? ` — ${lead.reason}` : "";
      return `- ${lead.path}${symbol}${reason}`;
    });
    leadsBlock = `${LEADS_BEGIN}${leadLines.join("\n")}\n${LEADS_END}`;
    parts.push(leadsBlock);
  }

  return {
    version: 1,
    content: parts.join("\n"),
    details: {
      snippets: prepared.snippets.map((s) => ({
        id: s.id,
        path: s.path,
        startLine: s.startLine,
        endLine: s.endLine,
        bytes: s.bytes,
        estimatedTokens: s.estimatedTokens,
        sourceHash: s.sourceHash,
        reason: s.reason,
      })),
      recommendedFiles: prepared.recommendedFiles.map((l) => ({
        path: l.path,
        symbol: l.symbol,
        reason: l.reason,
      })),
      totalBytes: prepared.totalBytes,
      estimatedTokens: prepared.estimatedTokens,
    },
  };
}

/** True when a serialized packet carries nothing worth injecting. */
export function isEmptyHandoff(handoff: DeliveredContextHandoff): boolean {
  return (
    handoff.details.snippets.length === 0 &&
    handoff.details.recommendedFiles.length === 0
  );
}