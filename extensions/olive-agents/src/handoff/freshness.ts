/**
 * handoff/freshness.ts — Launch-time verification of an approved packet.
 *
 * Verifies each approved snippet's whole-source sha256 against the file *at
 * the child's launch cwd* (decision B). For a worktree launch the child cwd is
 * the worktree copy; for a normal launch it is the parent working tree. This
 * means the check reads the exact bytes the child will see — dirty parent
 * edits or a moved HEAD cannot silently deliver evidence the worktree does not
 * contain, and a file that became a symlink escaping the root is refused by
 * the reader's read-time containment.
 *
 * Failures block the launch (the record errors before any child window opens);
 * the caller surfaces them through the agent feedback channel.
 */

import {
  normalizeLexicalPath,
  readerFor,
} from "./source.js";
import type { DeliveredContextHandoff } from "./serialize.js";

/** Returns human-readable failures; empty array means the packet is still valid. */
export async function verifyHandoffFreshness(
  handoff: DeliveredContextHandoff,
  childCwd: string,
): Promise<string[]> {
  const failures: string[] = [];
  const reader = readerFor("working-tree");
  for (const snippet of handoff.details.snippets) {
    const label = `${snippet.path}:${snippet.startLine}-${snippet.endLine}`;
    try {
      const { path: relativePath } = normalizeLexicalPath(snippet.path, childCwd);
      const { sourceHash } = await reader.readHash({
        sourceRoot: childCwd,
        relativePath,
      });
      if (sourceHash !== snippet.sourceHash) {
        failures.push(
          `${label} changed after it was reviewed; re-approve or re-propose before launching.`,
        );
      }
    } catch (error) {
      failures.push(
        `${label} is no longer available at the child working directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}