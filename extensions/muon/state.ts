import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { MUON_EXTENSION_NAME, MUON_STATE_ENTRY_TYPE } from "./constants.js";
import { formatEnabledSkills, normalizeMuonSkillIds, skillIdsToLegacySkillset, skillsetToSkillIds } from "./skills.js";
import type { MuonPersistedState, MuonState } from "./types.js";

export function createInitialMuonState(): MuonState {
  return {
    config: {
      skillset: "off",
      enabledSkills: [],
    },
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
  }
  return state;
}

export function persistMuonState(pi: ExtensionAPI, state: MuonState): void {
  pi.appendEntry(MUON_STATE_ENTRY_TYPE, { ...state, updatedAt: Date.now() } satisfies MuonPersistedState);
}

export function updateMuonStatus(ctx: ExtensionContext, state: MuonState): void {
  ctx.ui.setStatus(MUON_EXTENSION_NAME, undefined);

  const skills = formatEnabledSkills(state.config.enabledSkills);
  ctx.ui.setWidget(
    MUON_EXTENSION_NAME,
    (_tui, theme) => ({
      render(width: number) {
        return [truncateToWidth(theme.fg("accent", `μ: ${skills}`), width)];
      },
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}
