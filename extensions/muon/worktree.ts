import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface MuonWorktree {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  baseSha: string;
}

export interface ExecLike {
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

async function mustExec(pi: ExecLike, command: string, args: string[], cwd?: string): Promise<string> {
  const result = await pi.exec(command, args, { cwd, timeout: 60_000 });
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function prepareMuonWorktree(pi: ExecLike, cwd: string, runId: string, name: string): Promise<MuonWorktree | undefined> {
  const repoRoot = await mustExec(pi, "git", ["rev-parse", "--show-toplevel"], cwd);
  const baseSha = await mustExec(pi, "git", ["rev-parse", "HEAD"], repoRoot);
  const worktreesDir = join(repoRoot, ".worktrees");
  await mkdir(worktreesDir, { recursive: true });
  await appendFile(join(repoRoot, ".gitignore"), "\n.worktrees/\n", "utf8").catch(() => undefined);
  const branchName = `muon/${slug(name)}-${runId}`;
  const worktreePath = join(worktreesDir, branchName.replace(/\//g, "-"));
  // Run: git worktree add <path> -b <branch>
  await mustExec(pi, "git", ["worktree", "add", worktreePath, "-b", branchName], repoRoot);
  return { repoRoot, worktreePath, branchName, baseSha };
}

export async function checkpointMuonWorktree(pi: ExecLike, worktree: MuonWorktree, label: string): Promise<string | undefined> {
  const status = await mustExec(pi, "git", ["status", "--porcelain"], worktree.worktreePath);
  if (!status.trim()) return undefined;
  await mustExec(pi, "git", ["add", "-A"], worktree.worktreePath);
  await mustExec(pi, "git", ["commit", "-m", `muon: checkpoint ${label}`], worktree.worktreePath);
  return mustExec(pi, "git", ["rev-parse", "HEAD"], worktree.worktreePath);
}

export async function rollbackMuonWorktree(pi: ExecLike, worktreePath: string, targetRef: string): Promise<void> {
  await mustExec(pi, "git", ["reset", "--hard", targetRef], worktreePath);
  await mustExec(pi, "git", ["clean", "-fd"], worktreePath);
}
