import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySettings, loadSettings, saveSettings, writeTarget } from "../src/settings.js";

describe("settings persistence", () => {
  let globalDir: string; let projectDir: string; let old: string | undefined;
  beforeEach(() => { globalDir = mkdtempSync(join(tmpdir(), "oa-global-")); projectDir = mkdtempSync(join(tmpdir(), "oa-project-")); old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = globalDir; });
  afterEach(() => { if (old == null) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(globalDir, { recursive: true, force: true }); rmSync(projectDir, { recursive: true, force: true }); });

  it("round-trips retained settings via the global file when no project file exists", () => {
    const value = { maxConcurrent: 7, defaultMaxTurns: 30, graceTurns: 3, scopeModels: true, disableDefaultAgents: false, toolDescriptionMode: "compact" as const };
    const result = saveSettings(value, projectDir);
    expect(result.persisted).toBe(true);
    expect(result.scope).toBe("global");
    expect(result.path).toBe(join(globalDir, "olive-agents.json"));
    expect(loadSettings(projectDir)).toEqual(value);
    // No artifact in the cwd.
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });

  it("writes to the project file when a project override already exists", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "olive-agents.json"), JSON.stringify({ maxConcurrent: 2 }));
    const result = saveSettings({ maxConcurrent: 9 }, projectDir);
    expect(result.scope).toBe("project");
    expect(result.path).toBe(join(projectDir, ".pi", "olive-agents.json"));
    expect(JSON.parse(readFileSync(result.path, "utf-8"))).toEqual({ maxConcurrent: 9 });
    expect(existsSync(join(globalDir, "olive-agents.json"))).toBe(false);
  });

  it("writes to the project file when a legacy subagents.json exists, and migrates it", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    const legacy = join(projectDir, ".pi", "subagents.json");
    writeFileSync(legacy, JSON.stringify({ maxConcurrent: 4 }));
    const result = saveSettings({ maxConcurrent: 4, graceTurns: 5 }, projectDir);
    expect(result.scope).toBe("project");
    expect(existsSync(legacy)).toBe(false); // migrated away
    expect(existsSync(join(projectDir, ".pi", "olive-agents.json"))).toBe(true);
  });

  it("reads legacy subagents.json as a fallback (new name wins when both exist)", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ maxConcurrent: 4, graceTurns: 1 }));
    writeFileSync(join(projectDir, ".pi", "olive-agents.json"), JSON.stringify({ maxConcurrent: 8 }));
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 8, graceTurns: 1 });
  });

  it("silently drops retired scheduling and UI settings", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "olive-agents.json"), JSON.stringify({ schedulingEnabled: true, fleetView: false, widgetMode: "all", defaultJoinMode: "smart", maxConcurrent: 4 }));
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4 });
  });

  it("applies only retained fields", () => {
    const a = { setMaxConcurrent: vi.fn(), setDefaultMaxTurns: vi.fn(), setGraceTurns: vi.fn(), setScopeModels: vi.fn(), setDisableDefaultAgents: vi.fn(), setToolDescriptionMode: vi.fn() };
    applySettings({ maxConcurrent: 4, scopeModels: true }, a);
    expect(a.setMaxConcurrent).toHaveBeenCalledWith(4);
    expect(a.setScopeModels).toHaveBeenCalledWith(true);
    expect(a.setToolDescriptionMode).not.toHaveBeenCalled();
  });

  it("ignores the retired closeWindowOnComplete field", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "olive-agents.json"), JSON.stringify({ closeWindowOnComplete: true, maxConcurrent: 2 }));
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 2 });
  });

  it("writeTarget reports global when nothing exists and project when it does", () => {
    expect(writeTarget(projectDir).scope).toBe("global");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "olive-agents.json"), "{}");
    expect(writeTarget(projectDir).scope).toBe("project");
  });
});
