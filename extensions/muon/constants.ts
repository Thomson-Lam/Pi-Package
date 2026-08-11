import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const MUON_EXTENSION_NAME = "muon";
export const MUON_STATE_ENTRY_TYPE = "muon-state";
export const MUON_EXTENSION_DIR = HERE;
export const MUON_PACKAGE_ROOT_DIR = join(HERE, "..", "..");
export const MUON_MODES_DIR = join(HERE, "modes");
export const MUON_BUILD_PROMPT_PATH = join(MUON_MODES_DIR, "build-prompt.md");
export const MUON_SPEC_PROMPT_PATH = join(MUON_MODES_DIR, "spec-prompt.md");
export const MUON_SKILLSETS_DIR = join(HERE, "skillsets");
export const MUON_PONYTAIL_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "ponytail");
export const MUON_STANDALONE_SKILLS_DIR = join(MUON_SKILLSETS_DIR, "standalone");
export const MUON_AUTHORING_SKILLS_DIR = join(MUON_STANDALONE_SKILLS_DIR, "authoring-skills");
export const MUON_CINDEX_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "cindex");
export const MUON_GITHUB_ISSUES_PRS_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "github-issues-prs");
export const MUON_IPYNB_TOOLS_SHED_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "ipynb_toolshed");
export const MUON_TMUX_TDL_LOGS_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "tmux-tdl-logs");
export const MUON_YAGNI_PRODUCT_DESIGN_SKILL_DIR = join(MUON_STANDALONE_SKILLS_DIR, "yagni-product-design");
