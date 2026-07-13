import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const MUON_EXTENSION_NAME = "muon";
export const MUON_STATE_ENTRY_TYPE = "muon-state";
export const MUON_EXTENSION_DIR = HERE;
export const MUON_PACKAGE_ROOT_DIR = join(HERE, "..", "..");
export const MUON_SKILLSETS_DIR = join(HERE, "skillsets");
export const MUON_ROUTER_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "muon");
export const MUON_PONYTAIL_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "ponytail");
export const MUON_SUPERPOWERS_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "superpowers");
export const MUON_STANDALONE_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "standalone");
export const MUON_CINDEX_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "cindex");
export const MUON_IPYNB_TOOLS_SHED_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "ipynb_toolshed");
export const MUON_HANDOFF_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "handoff");
export const MUON_YAGNI_SCOPE_GUARD_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "yagni-scope-guard");
