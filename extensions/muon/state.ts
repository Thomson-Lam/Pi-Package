import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { MUON_EXTENSION_NAME, MUON_STATE_ENTRY_TYPE } from "./constants.js";
import { normalizeModeSkillIds, normalizeMuonSkillIds, formatEnabledSkills } from "./skills.js";
import { restoreConfigFromEntries } from "./state-policy.js";
import type { MuonPersistedState, MuonState } from "./types.js";

export function createInitialMuonState(): MuonState {
  return {
    config: {
      mode: "off",
      enabledSkills: ["ponytail", "cindex", "github-issues-prs", "handoff", "tmux-tdl-logs"],
    },
  };
}

export function restoreMuonState(ctx: ExtensionContext): MuonState {
  const state = createInitialMuonState();

  // Mode and skill selection is session-global configuration. It intentionally
  // follows append order across the session and does not rewind with /tree.
  state.config = restoreConfigFromEntries(ctx.sessionManager.getEntries(), state.config, {
    normalizeSkillIds: normalizeMuonSkillIds,
    normalizeModeSkillIds,
  });
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
        return [truncateToWidth(theme.fg("accent", `μ: ${state.config.mode} · ${skills}`), width)];
      },
      invalidate() {},
    }),
    { placement: "belowEditor" },
  );
}
