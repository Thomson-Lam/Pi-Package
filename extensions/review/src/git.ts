import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type DiffMode = "worktree" | "staged" | "baseRef";

export type GitFileDiff = {
  path: string;
  status: string;
  added: number;
  deleted: number;
  patch: string | null;
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
  const patchText = runGit(repoRoot, [...diffArgs, "--patch", "--find-renames", "--"]);

  const numMap = new Map<string, { a: number; d: number }>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [aRaw, dRaw, ...rest] = line.split("\t");
    const p = finalPathFromGitFields(rest);
    numMap.set(p, { a: Number(aRaw) || 0, d: Number(dRaw) || 0 });
  }

  const patchByFile = splitPatchByFile(patchText);
  const files: GitFileDiff[] = [];
  let totalPatch = 0;

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...rest] = line.split("\t");
    const path = finalPathFromGitFields(rest);
    const m = numMap.get(path) || { a: 0, d: 0 };
    const patch = patchByFile.get(path) ?? null;
    const bytes = Buffer.byteLength(patch ?? "");
    totalPatch += bytes;
    const capped = bytes > opts.maxFilePatchBytes || totalPatch > opts.maxPatchBytes;
    files.push({
      path,
      status,
      added: m.a,
      deleted: m.d,
      patch: capped ? null : patch,
      note: capped ? "Diff omitted: exceeds size cap" : patch ? undefined : "Diff omitted: binary file or no textual patch",
    });
  }

  if (opts.includeUntracked) {
    const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]).trim();
    for (const p of untracked.split("\n").filter(Boolean)) {
      if (isIgnoredReviewArtifactPath(p)) continue;
      const abs = join(repoRoot, p);
      const size = statSync(abs).size;
      if (size > opts.maxFilePatchBytes) {
        files.push({ path: p, status: "A", added: 0, deleted: 0, patch: null, note: "Diff omitted: exceeds size cap" });
        continue;
      }
      const buf = readFileSync(abs);
      const text = buf.toString("utf8");
      if (text.includes("\u0000")) {
        files.push({ path: p, status: "A", added: 0, deleted: 0, patch: null, note: "Diff omitted: binary file" });
      } else {
        const lines = text.split("\n");
        const synthetic = `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n${lines.map((l) => `+${l}`).join("\n")}`;
        files.push({ path: p, status: "A", added: lines.length, deleted: 0, patch: synthetic, note: "Synthetic untracked diff" });
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
  return path === ".pi/reviews" || path.startsWith(".pi/reviews/");
}

function finalPathFromGitFields(fields: string[]): string {
  if (fields.length === 0) return "";
  return (fields[fields.length - 1] || "").trim();
}

function splitPatchByFile(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = patch.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const whole = `diff --git ${part}`;
    const m = whole.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    if (!m) continue;
    out.set(m[2], whole);
  }
  return out;
}
