import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME, STATE_ENTRY_TYPE } from "./constants.js";
import type { PlanModePersistedState, PlanModeState } from "./types.js";

export function createInitialState(): PlanModeState {
  return {
    enabled: false,
    currentPlanName: undefined,
    activeSuModules: [],
    planAttachments: {},
    activeAttachedPlanName: undefined,
    planStoreMode: "global",
    planLocations: {},
  };
}

export function restoreState(ctx: ExtensionContext): PlanModeState {
  const state = createInitialState();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data) continue;
    const data = entry.data as Partial<PlanModePersistedState>;
    state.enabled = data.enabled ?? state.enabled;
    state.currentPlanName = data.currentPlanName ?? state.currentPlanName;
    state.activeSuModules = Array.isArray(data.activeSuModules) ? data.activeSuModules : state.activeSuModules;
    const legacyAttachment = (data as any).planAttachment;
    if (data.planAttachments && typeof data.planAttachments === "object") {
      state.planAttachments = data.planAttachments;
    } else if (legacyAttachment && typeof legacyAttachment === "object" && legacyAttachment.planName) {
      state.planAttachments = { [legacyAttachment.planName]: legacyAttachment };
    }
    state.activeAttachedPlanName =
      data.activeAttachedPlanName ??
      (legacyAttachment && legacyAttachment.planName ? legacyAttachment.planName : state.activeAttachedPlanName);
    state.planStoreMode = data.planStoreMode === "repo" || data.planStoreMode === "global" ? data.planStoreMode : state.planStoreMode;
    state.planLocations = data.planLocations && typeof data.planLocations === "object" ? data.planLocations : state.planLocations;
  }
  return state;
}

export function persistState(pi: ExtensionAPI, state: PlanModeState): void {
  const entry: PlanModePersistedState = {
    ...state,
    updatedAt: Date.now(),
  };
  pi.appendEntry(STATE_ENTRY_TYPE, entry);
}

export function updateStatus(ctx: ExtensionContext, state: PlanModeState): void {
  if (!state.enabled) {
    ctx.ui.setStatus(EXTENSION_NAME, undefined);
    ctx.ui.setWidget(EXTENSION_NAME, undefined);
    return;
  }

  ctx.ui.setStatus(EXTENSION_NAME, ctx.ui.theme.fg("warning", "plan:on"));
  const lines = [
    `mode: plan`,
    `current: ${state.currentPlanName ?? "—"}`,
    `store: ${state.planStoreMode}`,
    `attached: ${state.activeAttachedPlanName ?? "—"} (${Object.keys(state.planAttachments).length})`,
    `sumodules: ${state.activeSuModules.length > 0 ? state.activeSuModules.join(", ") : "—"}`,
  ];
  ctx.ui.setWidget(EXTENSION_NAME, lines);
}
