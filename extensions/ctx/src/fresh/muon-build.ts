import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Muon build-mode glue for /cb.
 *
 * The new session must carry the same `muon-state` custom entry that Muon's
 * own `/build` command writes (`newSessionInMode("build")`): config with
 * mode "build" and the build-synced skill bundle. Muon's session_start then
 * restores that state and its before_agent_start appends the build prompt —
 * ctx never touches the prompt text itself.
 *
 * Muon modules are loaded dynamically so that a missing or broken Muon
 * extension degrades to `undefined` instead of breaking the ctx extension.
 * All module fields are validated structurally; nothing is assumed beyond
 * the shapes Muon itself defines.
 */

export interface MuonBuildSetupAppender {
  (sessionManager: { appendCustomEntry(type: string, data?: unknown): void }): void;
}

export interface MuonBuildModules {
  MUON_STATE_ENTRY_TYPE: unknown;
  restoreMuonState: unknown;
  selectModeSkillIds: unknown;
  createInitialMuonState: unknown;
}

interface MuonStateLike {
  config?: { enabledSkills?: unknown };
}

export async function resolveMuonBuildSetupEntry(
  ctx: ExtensionContext,
): Promise<MuonBuildSetupAppender | undefined> {
  let modules: MuonBuildModules;
  try {
    const [constants, state, skills] = await Promise.all([
      import("../../../muon/constants.js"),
      import("../../../muon/state.js"),
      import("../../../muon/skills.js"),
    ]);
    modules = {
      MUON_STATE_ENTRY_TYPE: constants.MUON_STATE_ENTRY_TYPE,
      restoreMuonState: state.restoreMuonState,
      selectModeSkillIds: skills.selectModeSkillIds,
      createInitialMuonState: state.createInitialMuonState,
    };
  } catch {
    return undefined;
  }
  return composeMuonBuildSetup(modules, ctx);
}

export function composeMuonBuildSetup(
  modules: MuonBuildModules,
  ctx: ExtensionContext,
): MuonBuildSetupAppender | undefined {
  if (typeof modules.MUON_STATE_ENTRY_TYPE !== "string") return undefined;
  if (typeof modules.restoreMuonState !== "function") return undefined;
  if (typeof modules.createInitialMuonState !== "function") return undefined;

  let skills: unknown;
  try {
    const current = (modules.restoreMuonState as (ctx: ExtensionContext) => MuonStateLike)(ctx);
    const currentSkills = Array.isArray(current?.config?.enabledSkills)
      ? current.config.enabledSkills
      : [];
    skills =
      typeof modules.selectModeSkillIds === "function"
        ? (modules.selectModeSkillIds as (values: readonly unknown[], mode: string) => unknown)(
            currentSkills,
            "build",
          )
        : currentSkills;
  } catch {
    try {
      skills = (modules.createInitialMuonState as () => MuonStateLike)().config?.enabledSkills;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(skills)) return undefined;

  return (sessionManager) => {
    sessionManager.appendCustomEntry(modules.MUON_STATE_ENTRY_TYPE as string, {
      config: { mode: "build", enabledSkills: skills },
      updatedAt: Date.now(),
    });
  };
}
