import { existsSync, realpathSync } from "node:fs";
import {
  MUON_AUTHORING_SKILLS_DIR,
  MUON_CINDEX_SKILL_DIR,
  MUON_GITHUB_ISSUES_PRS_SKILL_DIR,
  MUON_IPYNB_TOOLS_SHED_SKILL_DIR,
  MUON_PONYTAIL_SKILLS_DIR,
  MUON_TMUX_TDL_LOGS_SKILL_DIR,
  MUON_YAGNI_PRODUCT_DESIGN_SKILL_DIR,
} from "./constants.js";
import {
  applySkillProfile as applySkillProfilePolicy,
  normalizeModeSkillIds as normalizeModeSkillIdsPolicy,
  selectModeSkillIds as selectModeSkillIdsPolicy,
} from "./mode-policy.js";
import type { MuonMode, MuonSkillId, MuonSkillProfile } from "./types.js";

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
    description: "Ponytail coding, review, and debt skills.",
    paths: () => [MUON_PONYTAIL_SKILLS_DIR],
  },
  {
    id: "authoring-skills",
    label: "authoring-skills",
    kind: "skill",
    description: "Create, revise, or evaluate reusable agent skills.",
    paths: () => [MUON_AUTHORING_SKILLS_DIR],
  },
  {
    id: "cindex",
    label: "cindex",
    kind: "skill",
    description: "Create, update, or audit lightweight INDEX.md navigation pointers.",
    paths: () => [MUON_CINDEX_SKILL_DIR],
  },
  {
    id: "github-issues-prs",
    label: "github-issues-prs",
    kind: "skill",
    description: "Read GitHub issues and create issues or pull requests with gh.",
    paths: () => [MUON_GITHUB_ISSUES_PRS_SKILL_DIR],
  },
  {
    id: "ipynb-toolshed",
    label: "ipynb-toolshed",
    kind: "skill",
    description: "Notebook inspection/edit scripts for .ipynb work without raw JSON editing.",
    paths: () => [MUON_IPYNB_TOOLS_SHED_SKILL_DIR],
  },
  {
    id: "tmux-tdl-logs",
    label: "tmux-tdl-logs",
    kind: "skill",
    description: "Inspect companion dev-server pane output in the td tmux workflow.",
    paths: () => [MUON_TMUX_TDL_LOGS_SKILL_DIR],
  },
  {
    id: "yagni-product-design",
    label: "yagni-product-design",
    kind: "skill",
    description: "Challenge assumptions and unnecessary scope in product plans.",
    paths: () => [MUON_YAGNI_PRODUCT_DESIGN_SKILL_DIR],
  },
];

const SOURCE_BY_ID = new Map(MUON_SKILL_SOURCES.map((source) => [source.id, source]));
const SOURCE_ORDER = MUON_SKILL_SOURCES.map((source) => source.id);

export function isMuonSkillId(value: string): value is MuonSkillId {
  return SOURCE_BY_ID.has(value as MuonSkillId);
}

export function getMuonSkillSource(id: MuonSkillId): MuonSkillSource {
  return SOURCE_BY_ID.get(id)!;
}

export function normalizeMuonSkillIds(values: readonly string[] | undefined): MuonSkillId[] {
  const enabled = new Set<MuonSkillId>();
  for (const value of values ?? []) {
    const id = value.trim();
    if (isMuonSkillId(id)) enabled.add(id);
  }
  return MUON_SKILL_SOURCES.map((source) => source.id).filter((id) => enabled.has(id));
}

export function normalizeModeSkillIds(values: readonly MuonSkillId[], mode: MuonMode): MuonSkillId[] {
  return normalizeModeSkillIdsPolicy(values, mode, SOURCE_ORDER) as MuonSkillId[];
}

export function selectModeSkillIds(values: readonly MuonSkillId[], mode: MuonMode): MuonSkillId[] {
  return selectModeSkillIdsPolicy(values, mode, SOURCE_ORDER) as MuonSkillId[];
}

export function applySkillProfile(values: readonly MuonSkillId[], profile: MuonSkillProfile): MuonSkillId[] {
  return applySkillProfilePolicy(values, profile, SOURCE_ORDER) as MuonSkillId[];
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
