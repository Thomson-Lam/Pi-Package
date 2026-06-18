import os from "node:os";
import path from "node:path";

export const EXTENSION_NAME = "plan-mode";
export const STATE_ENTRY_TYPE = "plan-mode-state";
export const PLAN_MODE_DIR = path.join(os.homedir(), ".pi", "agent", "plan-mode");
export const PLANS_DIR = path.join(PLAN_MODE_DIR, "plans");
export const SUMODULES_DIR = path.join(PLAN_MODE_DIR, "sumodules");
export const CONFIG_PATH = path.join(PLAN_MODE_DIR, "config.json");

