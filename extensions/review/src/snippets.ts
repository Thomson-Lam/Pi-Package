import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitSnapshot } from "./git.js";
import type { ReviewReport, SnippetRef } from "./schema.js";

export type ResolvedSnippet = SnippetRef & {
  lines: Array<{ number: number; text: string; highlighted: boolean }>;
  error?: string;
};

export type SnippetResolution = {
  snippets: ResolvedSnippet[];
  byId: Map<string, ResolvedSnippet>;
  warnings: string[];
};

export function resolveSnippets(report: ReviewReport, git: GitSnapshot): SnippetResolution {
  const warnings: string[] = [];
  const snippets = (report.snippets || []).map((ref) => resolveSnippet(ref, git, warnings));
  return { snippets, byId: new Map(snippets.map((snippet) => [snippet.id, snippet])), warnings };
}

function resolveSnippet(ref: SnippetRef, git: GitSnapshot, warnings: string[]): ResolvedSnippet {
  const source = ref.source || defaultSourceForMode(git.mode);
  let text: string;
  try {
    text = source === "worktree" ? readFileSync(join(git.repoRoot, ref.path), "utf8") : readGitBlob(git, ref.path, source);
  } catch (e) {
    const error = `Could not read ${source} snippet ${ref.path}:${ref.startLine}-${ref.endLine}: ${e instanceof Error ? e.message : String(e)}`;
    warnings.push(error);
    return { ...ref, source, lines: [], error };
  }

  const allLines = text.split(/\r?\n/);
  if (ref.startLine > allLines.length) {
    const error = `Snippet ${ref.id} starts at line ${ref.startLine}, but ${ref.path} has ${allLines.length} line(s).`;
    warnings.push(error);
    return { ...ref, source, lines: [], error };
  }
  const endLine = Math.min(ref.endLine, allLines.length);
  if (endLine < ref.endLine) warnings.push(`Snippet ${ref.id} was truncated to ${ref.path}:${ref.startLine}-${endLine}; requested endLine ${ref.endLine}.`);

  const slice = allLines.slice(ref.startLine - 1, endLine).join("\n");
  for (const needle of ref.mustContain || []) {
    if (!slice.includes(needle)) warnings.push(`Snippet ${ref.id} does not contain required anchor ${JSON.stringify(needle)}.`);
  }

  const highlightSet = new Set(ref.highlights || []);
  return {
    ...ref,
    source,
    lines: allLines.slice(ref.startLine - 1, endLine).map((line, index) => {
      const number = ref.startLine + index;
      return { number, text: line, highlighted: highlightSet.has(number) };
    }),
  };
}

function defaultSourceForMode(mode: GitSnapshot["mode"]): NonNullable<SnippetRef["source"]> {
  return mode === "staged" ? "index" : "worktree";
}

function readGitBlob(git: GitSnapshot, path: string, source: NonNullable<SnippetRef["source"]>): string {
  const spec = source === "index" ? `:${path}` : source === "base" ? `${git.baseLabel}:${path}` : `HEAD:${path}`;
  return execFileSync("git", ["show", spec], { cwd: git.repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).toString();
}
