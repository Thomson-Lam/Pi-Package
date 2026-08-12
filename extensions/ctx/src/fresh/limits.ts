import type { FreshLimits } from "./types.js";

export const DEFAULT_FRESH_LIMITS: FreshLimits = {
  maxLedgerFiles: 500,
  maxSelectedFiles: 24,
  maxFileBytes: 100_000,
  maxTransferTokens: 100_000,
};

export function limitsForContextWindow(contextWindow?: number): FreshLimits {
  if (!contextWindow || contextWindow <= 0) return { ...DEFAULT_FRESH_LIMITS };
  return {
    ...DEFAULT_FRESH_LIMITS,
    maxTransferTokens: Math.min(DEFAULT_FRESH_LIMITS.maxTransferTokens, Math.floor(contextWindow * 0.5)),
  };
}
