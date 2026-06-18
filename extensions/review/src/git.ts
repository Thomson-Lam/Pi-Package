import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DiffMode = "worktree" | "staged" | "baseRef";

export type GitFileDiff = {
  path: string;
  status: string;
  added: number;
  deleted: number;
  note?: string;
};

export type GitSnapshot = {
  repoRoot: string;
  branch: string;
  headSha: string;
  baseLabel: string;
  mode: DiffMode;
  totals: {
    files: number;
    added: number;
    deleted: number;
  };
  files: GitFileDiff[];
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).toString();
}

export function collectGitSnapshot(opts: {
  cwd: string;
  mode: DiffMode;
  base?: string;
  includeUntracked?: boolean;
  maxPatchBytes: number;
  maxFilePatchBytes: number;
}): GitSnapshot {
  const repoRoot = runGit(opts.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const branch = runGit(opts.cwd, ["branch", "--show-current"]).trim() || "(detached)";
  const headSha = runGit(opts.cwd, ["rev-parse", "HEAD"]).trim();

  const baseLabel = opts.mode === "baseRef" ? opts.base || "HEAD" : "HEAD";
  const diffArgs =
    opts.mode === "staged"
      ? ["diff", "--cached"]
      : opts.mode === "baseRef"
        ? ["diff", opts.base || "HEAD"]
        : ["diff", "HEAD"];

  const nameStatus = runGit(repoRoot, [...diffArgs, "--name-status", "--find-renames", "--"]).trim();
  const numstat = runGit(repoRoot, [...diffArgs, "--numstat", "--find-renames", "--"]).trim();
  const numMap = new Map<string, { a: number; d: number }>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [aRaw, dRaw, ...rest] = line.split("\t");
    const p = finalPathFromGitFields(rest);
    numMap.set(p, { a: Number(aRaw) || 0, d: Number(dRaw) || 0 });
  }

  const files: GitFileDiff[] = [];

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split("\t");
    const path = finalPathFromGitFields(rest);
    const m = numMap.get(path) || { a: 0, d: 0 };
    files.push({ path, status, added: m.a, deleted: m.d });
  }

  if (opts.includeUntracked) {
    const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]).trim();
    for (const p of untracked.split("\n").filter(Boolean)) {
      if (isIgnoredReviewArtifactPath(p)) continue;
      const abs = join(repoRoot, p);
      const size = statSync(abs).size;
      if (size > opts.maxFilePatchBytes) {
        files.push({ path: p, status: "A", added: 0, deleted: 0, note: "Large untracked file" });
        continue;
      }
      const buf = readFileSync(abs);
      const text = buf.toString("utf8");
      if (text.includes("\u0000")) {
        files.push({ path: p, status: "A", added: 0, deleted: 0, note: "Binary untracked file" });
      } else {
        const lines = text.split("\n");
        files.push({ path: p, status: "A", added: lines.length, deleted: 0, note: "Untracked file" });
      }
    }
  }

  if (files.length === 0) {
    const target = opts.mode === "staged" ? "staged changes" : opts.mode === "baseRef" ? `changes against ${baseLabel}` : "worktree changes";
    throw new Error(`No ${target} found. Make changes first, choose another --mode/--base, or pass --include-untracked for new files.`);
  }

  const totals = {
    files: files.length,
    added: files.reduce((sum, f) => sum + f.added, 0),
    deleted: files.reduce((sum, f) => sum + f.deleted, 0),
  };

  return { repoRoot, branch, headSha, baseLabel, mode: opts.mode, totals, files };
}

function isIgnoredReviewArtifactPath(path: string): boolean {
  return path === ".pi/reviews" || path.startsWith(".pi/reviews/") || path === "html-reviews" || path.startsWith("html-reviews/");
}

function finalPathFromGitFields(fields: string[]): string {
  if (fields.length === 0) return "";
  return (fields[fields.length - 1] || "").trim();
}

