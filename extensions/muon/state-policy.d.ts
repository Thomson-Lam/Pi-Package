export interface PersistedEntryLike {
  type?: string;
  customType?: string;
  data?: any;
}

export function restoreConfigFromEntries<T extends string, M extends string>(
  entries: readonly PersistedEntryLike[],
  initial: { mode: M; enabledSkills: T[] },
  policies: {
    normalizeSkillIds(values: readonly string[]): T[];
    normalizeModeSkillIds(values: readonly T[], mode: M): T[];
  },
): { mode: M; enabledSkills: T[] };
