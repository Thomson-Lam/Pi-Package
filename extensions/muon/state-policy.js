const MUON_STATE_ENTRY_TYPE = "muon-state";
const LEGACY_FOUNDATION_STATE_ENTRY_TYPE = "foundation-mode-state";

const isMuonMode = (value) => value === "off" || value === "engineering" || value === "foundation";

function migrateLegacySkillset(value) {
  if (value === "ponytail" || value === "auto") return ["ponytail"];
  if (value === "off" || value === "superpowers") return [];
  return undefined;
}

export function restoreConfigFromEntries(entries, initial, policies) {
  const configState = {
    mode: initial.mode,
    enabledSkills: [...initial.enabledSkills],
  };

  for (const entry of entries) {
    if (entry?.type !== "custom" || !entry.data) continue;

    if (entry.customType === LEGACY_FOUNDATION_STATE_ENTRY_TYPE) {
      if (typeof entry.data.enabled === "boolean") {
        configState.mode = entry.data.enabled ? "foundation" : "off";
      }
      continue;
    }

    if (entry.customType !== MUON_STATE_ENTRY_TYPE) continue;
    const config = entry.data.config;
    if (!config || typeof config !== "object") continue;

    if (isMuonMode(config.mode)) configState.mode = config.mode;

    if (Array.isArray(config.enabledSkills)) {
      configState.enabledSkills = policies.normalizeSkillIds(config.enabledSkills.filter((id) => typeof id === "string"));
    } else {
      const migrated = migrateLegacySkillset(config.skillset);
      if (migrated !== undefined) configState.enabledSkills = migrated;
      else if (config.superpowersMode === "on") configState.enabledSkills = ["ponytail"];
      else if (config.superpowersMode === "off") configState.enabledSkills = [];
    }
  }

  configState.enabledSkills = policies.normalizeModeSkillIds(configState.enabledSkills, configState.mode);
  return configState;
}
