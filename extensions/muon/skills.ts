import { existsSync, realpathSync } from "node:fs";
import {
  MUON_HANDOFF_SKILL_DIR,
  MUON_IPYNB_TOOLS_SHED_SKILL_DIR,
  MUON_CINDEX_SKILL_DIR,
  MUON_PONYTAIL_SKILLS_DIR,
  MUON_ROUTER_SKILLS_DIR,
  MUON_SUPERPOWERS_SKILLS_DIR,
} from "./constants.js";
import type { MuonSkillId, MuonSkillset } from "./types.js";

export interface MuonSkillSource {
  id: MuonSkillId;
  label: string;
  kind: "profile" | "skill";
  description: string;
  paths: () => string[];
}

export const MUON_SKILL_SOURCES: MuonSkillSource[] = [
  {
    id: "ponytail",
    label: "Ponytail",
    kind: "profile",
    description: "Muon router plus Ponytail coding, review, and debt skills.",
    paths: () => [MUON_ROUTER_SKILLS_DIR, MUON_PONYTAIL_SKILLS_DIR],
  },
  {
    id: "superpowers",
    label: "Superpowers",
    kind: "profile",
    description: "Muon router plus Superpowers planning, TDD, debugging, worktree, and review workflows.",
    paths: () => [MUON_ROUTER_SKILLS_DIR, MUON_SUPERPOWERS_SKILLS_DIR],
  },
  {
    id: "cindex",
    label: "cindex",
    kind: "skill",
    description: "Create, update, or audit lightweight INDEX.md navigation pointers.",
    paths: () => [MUON_CINDEX_SKILL_DIR],
  },
  {
    id: "handoff",
    label: "handoff",
    kind: "skill",
    description: "Create/update a handoff file for current work and context.",
    paths: () => [MUON_HANDOFF_SKILL_DIR],
  },
  {
    id: "ipynb-toolshed",
    label: "ipynb-toolshed",
    kind: "skill",
    description: "Notebook inspection/edit scripts for .ipynb work without raw JSON editing.",
    paths: () => [MUON_IPYNB_TOOLS_SHED_SKILL_DIR],
  },
];

const SOURCE_BY_ID = new Map(MUON_SKILL_SOURCES.map((source) => [source.id, source]));

export function isMuonSkillId(value: string): value is MuonSkillId {
  return SOURCE_BY_ID.has(value as MuonSkillId);
}

export function getMuonSkillSource(id: MuonSkillId): MuonSkillSource {
  return SOURCE_BY_ID.get(id)!;
}

export function normalizeMuonSkillIds(values: readonly string[] | undefined): MuonSkillId[] {
  const normalized: MuonSkillId[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const id = value.trim() as MuonSkillId;
    if (!isMuonSkillId(id) || seen.has(id)) continue;
    normalized.push(id);
    seen.add(id);
  }
  return normalized;
}

export function skillsetToSkillIds(skillset: MuonSkillset): MuonSkillId[] {
  switch (skillset) {
    case "off":
      return [];
    case "auto":
      return ["ponytail", "superpowers"];
    case "ponytail":
      return ["ponytail"];
    case "superpowers":
      return ["superpowers"];
  }
}

export function skillIdsToLegacySkillset(ids: readonly MuonSkillId[]): MuonSkillset {
  const enabled = new Set(ids);
  const ponytail = enabled.has("ponytail");
  const superpowers = enabled.has("superpowers");
  if (ponytail && superpowers) return "auto";
  if (ponytail) return "ponytail";
  if (superpowers) return "superpowers";
  return "off";
}

export function resolveEnabledSkillPaths(enabledSkillIds: readonly MuonSkillId[]): {
  skillPaths: string[];
  missingSkillIds: MuonSkillId[];
} {
  const skillPaths: string[] = [];
  const missingSkillIds: MuonSkillId[] = [];
  const seenPaths = new Set<string>();

  for (const id of enabledSkillIds) {
    const source = getMuonSkillSource(id);
    const paths = source.paths().filter((path) => existsSync(path));
    if (paths.length === 0) {
      missingSkillIds.push(id);
      continue;
    }
    for (const path of paths) {
      let canonical = path;
      try {
        canonical = realpathSync(path);
      } catch {}
      if (seenPaths.has(canonical)) continue;
      seenPaths.add(canonical);
      skillPaths.push(canonical);
    }
  }

  return { skillPaths, missingSkillIds };
}

export function formatEnabledSkills(enabledSkillIds: readonly MuonSkillId[]): string {
  return enabledSkillIds.length > 0 ? enabledSkillIds.join(", ") : "off";
}
