import { loadPromptConfig } from "./prompts.js";
import type { PlanModeState } from "./types.js";

export function buildPlanModePrompt(state: PlanModeState): string {
  const sumoduleLine =
    state.activeSuModules.length > 0
      ? `Active SuModules: ${state.activeSuModules.join(", ")}. Check whether the plan satisfies them and call out gaps.`
      : "No active SuModules are set for this session.";

  const currentPlanLine = state.currentPlanName
    ? `Current convenience plan pointer: ${state.currentPlanName}.`
    : "No current plan pointer is set.";

  const prompts = loadPromptConfig();
  return `${prompts.planModeSystemPrompt}\n${currentPlanLine}\n${sumoduleLine}`;
}
