const PROFILE_IDS = new Set(["ponytail"]);
const BUILD_SKILL_IDS = ["ponytail", "cindex", "github-issues-prs", "tmux-tdl-logs"];
const SPEC_SKILL_ID = "yagni-product-design";

function ordered(values, sourceOrder) {
  const enabled = new Set(values);
  return sourceOrder.filter((id) => enabled.has(id));
}

export function normalizeModeSkillIds(values, mode, sourceOrder) {
  const enabled = new Set(values);
  if (mode === "spec") enabled.add(SPEC_SKILL_ID);
  else enabled.delete(SPEC_SKILL_ID);
  return ordered(enabled, sourceOrder);
}

export function selectModeSkillIds(values, mode, sourceOrder) {
  const enabled = new Set(values);
  enabled.delete(SPEC_SKILL_ID);
  if (mode === "build") {
    for (const id of BUILD_SKILL_IDS) enabled.add(id);
  } else if (mode === "spec") {
    enabled.add(SPEC_SKILL_ID);
  }
  return ordered(enabled, sourceOrder);
}

export function applySkillProfile(values, profile, sourceOrder) {
  const enabled = new Set(values.filter((id) => !PROFILE_IDS.has(id)));
  if (profile !== "off") enabled.add(profile);
  return ordered(enabled, sourceOrder);
}
