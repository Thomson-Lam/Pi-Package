const MODES = new Set(["off", "build", "spec"]);
const SKILL_PROFILES = new Set(["off", "ponytail"]);
const DUMP_TARGETS = new Set(["pi", "agents", "claude", "codex"]);

export function parseMuonAction(args, skillIds) {
  const normalized = args.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return { kind: "menu" };

  const [verb, ...rest] = normalized.split(" ");
  const skillUsage = skillIds.join("|");

  if (verb === "help" || verb === "h" || verb === "?") {
    return rest.length === 0
      ? { kind: "action", action: { kind: "help" } }
      : { kind: "error", message: "Usage: /muon help" };
  }
  if (verb === "status") {
    return rest.length === 0
      ? { kind: "action", action: { kind: "status" } }
      : { kind: "error", message: "Usage: /muon status" };
  }

  if (MODES.has(verb)) {
    return rest.length === 0
      ? { kind: "action", action: { kind: "mode", mode: verb } }
      : { kind: "error", message: `Usage: /muon ${verb}` };
  }

  if (verb === "mode") {
    return rest.length === 0
      ? { kind: "action", action: { kind: "mode" } }
      : { kind: "error", message: "Usage: /muon mode" };
  }

  if (verb === "skill-dump" || verb === "skilldump") {
    const target = rest[0];
    if (rest.length === 0) return { kind: "action", action: { kind: "skill-dump" } };
    if (rest.length > 1 || !DUMP_TARGETS.has(target)) {
      return { kind: "error", message: "Usage: /muon skill-dump [pi|agents|claude|codex]" };
    }
    return { kind: "action", action: { kind: "skill-dump", target } };
  }

  if (verb === "skills") {
    const op = rest[0];
    const target = rest[1];
    if (!op) return { kind: "action", action: { kind: "skills" } };
    if (op === "status" || op === "list") {
      return rest.length === 1
        ? { kind: "action", action: { kind: "skills", op: "status" } }
        : { kind: "error", message: "Usage: /muon skills status" };
    }
    if ((op === "on" || op === "off" || op === "toggle") && target) {
      if (rest.length !== 2 || !skillIds.includes(target)) {
        return { kind: "error", message: `Usage: /muon skills ${op} <${skillUsage}>` };
      }
      return { kind: "action", action: { kind: "skills", op, skillId: target } };
    }
    if (SKILL_PROFILES.has(op) && rest.length === 1) {
      return { kind: "action", action: { kind: "skills", op: "profile", profile: op } };
    }
    return { kind: "error", message: "Usage: /muon skills [status|list|on <id>|off <id>|toggle <id>|off|ponytail]" };
  }

  return { kind: "error", message: "Usage: /muon [build|spec|off|status|mode|skills|skill-dump|help]" };
}
