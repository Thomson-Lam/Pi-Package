const PROFILE_IDS = new Set(["ponytail", "engineering", "foundation"]);
const MODE_SKILL_IDS = new Set(["engineering", "foundation"]);

function ordered(values, sourceOrder) {
  const enabled = new Set(values);
  return sourceOrder.filter((id) => enabled.has(id));
}

export function normalizeModeSkillIds(values, mode, sourceOrder) {
  const enabled = new Set(values);
  if (mode === "engineering") {
    enabled.delete("foundation");
    enabled.add("engineering");
  } else if (mode === "foundation") {
    enabled.delete("engineering");
    enabled.add("foundation");
  }
  return ordered(enabled, sourceOrder);
}

export function selectModeSkillIds(values, mode, sourceOrder) {
  const enabled = new Set(values.filter((id) => !MODE_SKILL_IDS.has(id)));
  if (mode === "engineering" || mode === "foundation") enabled.add(mode);
  return ordered(enabled, sourceOrder);
}

export function applySkillProfile(values, profile, sourceOrder) {
  const enabled = new Set(values.filter((id) => !PROFILE_IDS.has(id)));
  if (profile !== "off") enabled.add(profile);
  return ordered(enabled, sourceOrder);
}
