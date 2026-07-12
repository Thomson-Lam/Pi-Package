import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_DEPTH_DEFAULT, MAX_PARALLEL_DEFAULT, MUON_EXTENSION_NAME, MUON_STATE_ENTRY_TYPE } from "./constants.js";
import { formatEnabledSkills, normalizeMuonSkillIds, skillIdsToLegacySkillset, skillsetToSkillIds } from "./skills.js";
import type { MuonPersistedState, MuonState } from "./types.js";

export function createInitialMuonState(): MuonState {
  return {
    config: {
      skillset: "off",
      enabledSkills: [],
      maxParallel: MAX_PARALLEL_DEFAULT,
      maxDepth: MAX_DEPTH_DEFAULT,
      defaultAgentScope: "user",
      worktreeMode: "none",
    },
    activeRunId: undefined,
    runs: {},
  };
}

export function restoreMuonState(ctx: ExtensionContext): MuonState {
  const state = createInitialMuonState();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== MUON_STATE_ENTRY_TYPE || !entry.data) continue;
    const data = entry.data as Partial<MuonPersistedState>;
    const config = data.config as
      | (Partial<MuonPersistedState["config"]> & { superpowersMode?: "off" | "on" })
      | undefined;
    state.config = { ...state.config, ...(config ?? {}) };
    if (config?.superpowersMode && !("skillset" in config)) {
      state.config.skillset = config.superpowersMode === "on" ? "auto" : "off";
    }
    if (Array.isArray(config?.enabledSkills)) {
      state.config.enabledSkills = normalizeMuonSkillIds(config.enabledSkills);
      state.config.skillset = skillIdsToLegacySkillset(state.config.enabledSkills);
    } else if (config?.skillset) {
      state.config.enabledSkills = skillsetToSkillIds(state.config.skillset);
    }
    state.activeRunId = data.activeRunId ?? state.activeRunId;
    state.runs = data.runs && typeof data.runs === "object" ? data.runs : state.runs;
  }
  return state;
}

export function persistMuonState(pi: ExtensionAPI, state: MuonState): void {
  pi.appendEntry(MUON_STATE_ENTRY_TYPE, { ...state, updatedAt: Date.now() } satisfies MuonPersistedState);
}

export function updateMuonStatus(ctx: ExtensionContext, state: MuonState): void {
  const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
  const status = active ? `${active.status}:${active.name}` : `skills:${formatEnabledSkills(state.config.enabledSkills)}`;
  ctx.ui.setStatus(MUON_EXTENSION_NAME, ctx.ui.theme.fg(active?.status === "failed" ? "error" : "accent", `muon ${status}`));
}
