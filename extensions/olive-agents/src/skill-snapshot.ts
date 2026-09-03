/** Olive-owned serialization helpers for Pi's resolved Skill metadata. */

import type { Skill } from "@earendil-works/pi-coding-agent";

/**
 * A launch-time copy of Pi's public Skill shape. Keeping the full shape means
 * the child resource loader can provide the same prompt metadata and native
 * skill commands without rediscovering resources.
 */
export type SkillSnapshot = Skill;

function isSkill(value: unknown): value is Skill {
  if (!value || typeof value !== "object") return false;
  const skill = value as Partial<Skill> & { sourceInfo?: Record<string, unknown> };
  const source = skill.sourceInfo;
  return typeof skill.name === "string"
    && typeof skill.description === "string"
    && typeof skill.filePath === "string"
    && typeof skill.baseDir === "string"
    && typeof skill.disableModelInvocation === "boolean"
    && !!source
    && typeof source.path === "string"
    && typeof source.source === "string"
    && typeof source.scope === "string"
    && typeof source.origin === "string"
    && (source.baseDir === undefined || typeof source.baseDir === "string");
}

/**
 * Clone a resolved Skill[] into a JSON-safe snapshot. `undefined` means no
 * snapshot was available; an empty array is intentionally preserved.
 */
export function cloneSkillSnapshot(value: readonly Skill[] | unknown): SkillSnapshot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isSkill)) return undefined;
  return value.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: {
      path: skill.sourceInfo.path,
      source: skill.sourceInfo.source,
      scope: skill.sourceInfo.scope,
      origin: skill.sourceInfo.origin,
      ...(skill.sourceInfo.baseDir === undefined ? {} : { baseDir: skill.sourceInfo.baseDir }),
    },
    disableModelInvocation: skill.disableModelInvocation,
  }));
}

/** Validate and clone an untrusted persisted snapshot. */
export function parseSkillSnapshot(value: unknown): SkillSnapshot[] | undefined {
  return cloneSkillSnapshot(value);
}
