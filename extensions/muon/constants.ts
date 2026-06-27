import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MUON_EXTENSION_NAME = "muon";
export const MUON_STATE_ENTRY_TYPE = "muon-state";
export const MUON_RUN_MESSAGE_TYPE = "muon-run";
export const MUON_BOOTSTRAP_MARKER = "muon:superpowers bootstrap for pi";
export const MAX_PARALLEL_DEFAULT = 2;
export const MAX_PARALLEL_HARD_CAP = 8;
export const MAX_DEPTH_DEFAULT = 1;
export const MUON_ROOT_DIR = join(getAgentDir(), "muon");
export const MUON_RUNS_DIR = join(MUON_ROOT_DIR, "runs");
