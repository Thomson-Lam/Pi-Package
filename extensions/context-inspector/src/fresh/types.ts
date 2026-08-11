export interface ReadCandidate {
  path: string;
  absolutePath: string;
}

export interface ReadLedger {
  version: 1;
  projectRoot: string;
  candidates: ReadCandidate[];
}

export interface SelectionEnvelope {
  version: 1;
  paths: string[];
}

export type FileExclusionReason =
  | "missing"
  | "outside-project"
  | "not-file"
  | "unreadable"
  | "unsupported"
  | "oversized";

export interface PreparedFile {
  path: string;
  absolutePath: string;
  content: string;
  bytes: number;
  estimatedTokens: number;
  sha256: string;
}

export interface ExcludedFile {
  path: string;
  reason: FileExclusionReason;
  detail: string;
}

export interface PreparedContext {
  selectedPaths: string[];
  included: PreparedFile[];
  excluded: ExcludedFile[];
  totalBytes: number;
  estimatedTokens: number;
  blockedReason?: string;
}

export interface FreshLimits {
  maxLedgerFiles: number;
  maxSelectedFiles: number;
  maxFileBytes: number;
  maxTransferTokens: number;
}

export interface FreshReviewResult {
  action: "confirm" | "cancel";
  objective: string;
}

export type FreshOutcome =
  | { status: "completed" }
  | { status: "cancelled"; objective?: string }
  | { status: "failed"; stage: string; message: string };

export interface FreshContextMessageDetails {
  version: 1;
  paths: Array<{ path: string; bytes: number; estimatedTokens: number }>;
  totalBytes: number;
  estimatedTokens: number;
}
