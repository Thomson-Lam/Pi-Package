import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MUON_SKILL_SOURCES } from "./skills.js";

export type SkillDumpTarget = "pi" | "agents" | "claude" | "codex";

export interface SkillDumpResult {
  target: SkillDumpTarget;
  destRoot: string;
  dumped: Array<{ name: string; source: string; dest: string }>;
}

export function isSkillDumpTarget(value: string): value is SkillDumpTarget {
  return value === "pi" || value === "agents" || value === "claude" || value === "codex";
}

export function getSkillDumpDestRoot(cwd: string, target: SkillDumpTarget): string {
  switch (target) {
    case "pi":
      return join(cwd, ".pi", "skills");
    case "agents":
      return join(cwd, ".agents", "skills");
    case "claude":
      return join(cwd, ".claude", "skills");
    case "codex":
      return join(cwd, ".codex", "skills");
  }
}

async function existsDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function findSkillDirs(root: string): Promise<string[]> {
  if (!(await existsDir(root))) return [];

  const skillFile = join(root, "SKILL.md");
  try {
    if ((await stat(skillFile)).isFile()) return [root];
  } catch {}

  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    results.push(...await findSkillDirs(join(root, entry.name)));
  }
  return results;
}

function extractSkillName(content: string, fallback: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? "";
  const nameMatch = frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  return (nameMatch?.[1] ?? fallback).trim();
}

export async function dumpMuonSkills(cwd: string, target: SkillDumpTarget): Promise<SkillDumpResult> {
  const destRoot = getSkillDumpDestRoot(cwd, target);
  await mkdir(destRoot, { recursive: true });

  const sourceRoots = MUON_SKILL_SOURCES.flatMap((source) => source.paths());
  const sourceSkillDirs = new Set<string>();
  for (const root of sourceRoots) {
    for (const dir of await findSkillDirs(root)) sourceSkillDirs.add(dir);
  }

  const dumped: SkillDumpResult["dumped"] = [];
  for (const source of [...sourceSkillDirs].sort()) {
    const skillMd = await readFile(join(source, "SKILL.md"), "utf8");
    const name = extractSkillName(skillMd, basename(source));
    const dest = join(destRoot, name);
    await rm(dest, { recursive: true, force: true });
    await cp(source, dest, { recursive: true });
    dumped.push({ name, source, dest });
  }

  return { target, destRoot, dumped };
}
