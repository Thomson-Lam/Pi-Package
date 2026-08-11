import type { FreshContextMessageDetails, PreparedContext } from "./types.js";

export const FRESH_CONTEXT_MESSAGE_TYPE = "context-inspector:fresh-files";

export function serializeFreshFiles(files: PreparedContext["included"]): string {
  return files.map((file) => [
    `===== BEGIN CURRENT PROJECT FILE ${JSON.stringify(file.path)} =====`,
    file.content,
    `===== END CURRENT PROJECT FILE ${JSON.stringify(file.path)} =====`,
  ].join("\n")).join("\n\n");
}

export function buildFreshContextMessage(prepared: PreparedContext): {
  content: string;
  details: FreshContextMessageDetails;
} {
  return {
    content: serializeFreshFiles(prepared.included),
    details: {
      version: 1,
      paths: prepared.included.map((file) => ({ path: file.path, bytes: file.bytes, estimatedTokens: file.estimatedTokens })),
      totalBytes: prepared.totalBytes,
      estimatedTokens: prepared.estimatedTokens,
    },
  };
}
