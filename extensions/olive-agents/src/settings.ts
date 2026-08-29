// Persistence for olive-agents operational settings.
//
// Files are named olive-agents.json so it is clear which extension owns them:
//   - Global:  ~/.pi/agent/olive-agents.json (via getAgentDir()) — the default
//     write target; machine-level defaults.
//   - Project: <cwd>/.pi/olive-agents.json — optional per-project override.
//
// Write policy ("write where you already are, else global"): the project file
// is written only when one already exists (new name, or the legacy
// subagents.json name); otherwise writes go to the global file, so a settings
// change never creates a `.pi/` artifact in the cwd. Legacy `subagents.json`
// files are still READ as a fallback and are removed (migrated) on write.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JoinMode } from "./types.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
   *     has no `model:`, since frontmatter is authoritative): hard error
   *     returned to the orchestrator, listing the allowed models. The LLM
   *     made an explicit out-of-scope choice and gets explicit feedback.
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, the built-in default agent (general-purpose) is not
   * registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * When true, an agent's tmux window is closed as soon as its run settles
   * (unless the user is actively viewing that window). The Pi session file is
   * unaffected — the window can be reopened on demand. Defaults to true.
   */
  closeWindowOnComplete?: boolean;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setScopeModels: (enabled: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setCloseWindowOnComplete: (b: boolean) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.disableDefaultAgents === "boolean") {
    out.disableDefaultAgents = r.disableDefaultAgents;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.closeWindowOnComplete === "boolean") {
    out.closeWindowOnComplete = r.closeWindowOnComplete;
  }
  return out;
}

/** Current settings file name. Legacy name is subagents.json (read-only fallback). */
const SETTINGS_FILE = "olive-agents.json";
const LEGACY_SETTINGS_FILE = "subagents.json";

export type SettingsScope = "global" | "project";

export interface SaveResult {
  persisted: boolean;
  scope: SettingsScope;
  path: string;
}

function globalPath(): string {
  return join(getAgentDir(), SETTINGS_FILE);
}

function legacyGlobalPath(): string {
  return join(getAgentDir(), LEGACY_SETTINGS_FILE);
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", SETTINGS_FILE);
}

function legacyProjectPath(cwd: string): string {
  return join(cwd, ".pi", LEGACY_SETTINGS_FILE);
}

/**
 * Resolve the write target: the project file when one already exists (new or
 * legacy name), otherwise the global file. This is the "write where you already
 * are, else global" policy — a settings change never creates a `.pi/` artifact
 * in the cwd unless the user already has a project override.
 */
export function writeTarget(cwd: string = process.cwd()): { path: string; scope: SettingsScope; legacyPath?: string } {
  const project = projectPath(cwd);
  const legacyProject = legacyProjectPath(cwd);
  if (existsSync(project)) return { path: project, scope: "project" };
  if (existsSync(legacyProject)) return { path: project, scope: "project", legacyPath: legacyProject };
  return { path: globalPath(), scope: "global", legacyPath: existsSync(legacyGlobalPath()) ? legacyGlobalPath() : undefined };
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. New name
 *  wins over the legacy subagents.json fallback within each scope (later wins). */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return {
    ...readSettingsFile(legacyGlobalPath()),
    ...readSettingsFile(globalPath()),
    ...readSettingsFile(legacyProjectPath(cwd)),
    ...readSettingsFile(projectPath(cwd)),
  };
}

/**
 * Persist settings to the write target (project when one exists, else global)
 * under the olive-agents.json name. A legacy subagents.json file in the same
 * scope is removed after a successful write so reads cannot fall back to
 * stale values. Returns the outcome plus the resolved scope/path so the UI
 * can say where it wrote.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): SaveResult {
  const { path, scope, legacyPath } = writeTarget(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    if (legacyPath && legacyPath !== path) {
      try { rmSync(legacyPath, { force: true }); } catch { /* best effort */ }
    }
    return { persisted: true, scope, path };
  } catch {
    return { persisted: false, scope, path };
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.disableDefaultAgents === "boolean") appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.closeWindowOnComplete === "boolean") appliers.setCloseWindowOnComplete(s.closeWindowOnComplete);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 * Success messages name the file that was written (global or project scope).
 */
export function persistToastFor(
  successMsg: string,
  result: SaveResult,
): { message: string; level: "info" | "warning" } {
  if (!result.persisted) {
    return { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
  }
  const short = result.path.replace(homedir(), "~");
  return { message: `${successMsg} (saved to ${short})`, level: "info" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const result = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted: result.persisted, scope: result.scope, path: result.path });
  return persistToastFor(successMsg, result);
}
