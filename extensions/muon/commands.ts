import { existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
  applySkillProfile,
  formatEnabledSkills,
  isMuonSkillId,
  MUON_SKILL_SOURCES,
  normalizeModeSkillIds,
  resolveEnabledSkillPaths,
  selectModeSkillIds,
} from "./skills.js";
import { parseMuonAction } from "./command-parser.js";
import { dumpMuonSkills, getSkillDumpDestRoot, isSkillDumpTarget, type SkillDumpTarget } from "./skill-dump.js";
import type { MuonMode, MuonSkillId, MuonSkillProfile, MuonState } from "./types.js";

export interface MuonDeps {
  getState: () => MuonState;
  setState: (updater: (draft: MuonState) => void, ctx: ExtensionContext) => void;
}

const HELP_TEXT = `# /muon

Muon governs interaction modes, skill profiles, and individual skills in Pi's context window.

## Actions

- Skills — toggle Muon-governed skill profiles and individual skills.
- Mode — choose Minimal, Build, or Spec.
- Skill dump — write all Muon-managed skills to a project-local skill folder.
- Status — show the active mode, Muon skills, and loaded skill commands.
- Help — show this help modal.

## Usage

\`/muon status\`
\`/muon build\`
\`/muon spec\`
\`/muon off\`
\`/muon mode\`
\`/mus\`
\`/muon skills\`
\`/muon skills status|list\`
\`/muon skills on|off|toggle <skill-id>\`
\`/muon skills off|ponytail\`
\`/muon skill-dump [pi|agents|claude|codex]\`
\`/muon help\`

## Modes

Only one mode is active at a time. Build appends its implementation prompt to Pi's default system prompt (additive); Spec swaps only the default role sentence for its spec prompt and keeps Pi's tools, guidelines, and context; Minimal keeps it untouched. Activating Build enables Ponytail, cindex, github-issues-prs, and tmux-tdl-logs; each skill can then be toggled independently. Spec enables its YAGNI product-design scope guard, which is disabled when leaving Spec.

- \`off\` — Minimal: Pi's default coding-agent system prompt only (no Muon prompt injection).
- \`build\` — implementation-focused system prompt appended to Pi's default (additive) plus Ponytail, cindex, github-issues-prs, and tmux-tdl-logs.
- \`spec\` — product-specification system prompt in place of the default role, with Pi's tools, guidelines, and context intact, plus the YAGNI product-design scope guard.

Skills and profiles can be toggled independently through \`/muon skills\`.

## Skills

Muon exposes skills through Pi resource discovery, then reloads so Pi refreshes the skill catalog.

Profiles: \`ponytail\`.

Standalone skills: \`authoring-skills\`, \`cindex\`, \`github-issues-prs\`, \`ipynb-toolshed\`, \`tmux-tdl-logs\`.

Spec-owned skill: \`yagni-product-design\`.

External skills discovered by Pi outside Muon appear read-only with \`(external)\`.

## Skill dump

\`/muon skill-dump\` copies every Muon-managed skill into the selected project-local universal skill folder.`;

type MuonAction =
  | { kind: "status" }
  | { kind: "mode"; mode?: MuonMode; status?: boolean }
  | { kind: "skills"; op?: "ui" | "status" | "on" | "off" | "toggle" | "profile"; skillId?: MuonSkillId; profile?: MuonSkillProfile }
  | { kind: "skill-dump"; target?: SkillDumpTarget }
  | { kind: "help" };

type ParsedMuon = { kind: "menu" } | { kind: "action"; action: MuonAction } | { kind: "error"; message: string };

function isMuonMode(value: string): value is MuonMode {
  return value === "off" || value === "build" || value === "spec";
}

async function selectModal(ctx: ExtensionCommandContext, title: string, items: SelectItem[]): Promise<string | undefined> {
  const result = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(undefined);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • h help • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "h" || data === "H" || data === "?") {
          done("help");
          return;
        }
        if (data === "j" || data === "J") selectList.handleInput("\x1b[B");
        else if (data === "k" || data === "K") selectList.handleInput("\x1b[A");
        else selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return result;
}

async function pickMuonAction(ctx: ExtensionCommandContext): Promise<MuonAction | undefined> {
  const selected = await selectModal(ctx, "Muon", [
    { value: "skills", label: "Skills", description: "Toggle skill profiles and individual skills in context" },
    { value: "mode", label: "Mode", description: "Choose Minimal, Build, or Spec" },
    { value: "skill-dump", label: "Skill dump", description: "Write all Muon-managed skills to .pi/.agents/.claude/.codex" },
    { value: "status", label: "Status", description: "Show Muon mode, skill configuration, and loaded skill commands" },
    { value: "help", label: "Help", description: "Show Muon help" },
  ]);
  if (!selected) return undefined;
  if (selected === "mode") return { kind: "mode" };
  if (selected === "skills") return { kind: "skills" };
  if (selected === "skill-dump") return { kind: "skill-dump" };
  return { kind: selected as MuonAction["kind"] };
}

async function showMuonModePicker(ctx: ExtensionCommandContext, current: MuonMode): Promise<MuonMode | undefined> {
  const selected = await selectModal(ctx, `Muon mode (current: ${current})`, [
    { value: "off", label: "Minimal", description: "Default Pi coding-agent system prompt only" },
    { value: "build", label: "Build", description: "Implementation prompt appended to Pi default (additive), with default Muon skills" },
    { value: "spec", label: "Spec", description: "Spec prompt in place of the default role, with Pi's tools/guidelines/context intact, YAGNI scope guard" },
  ]);
  return selected && isMuonMode(selected) ? selected : undefined;
}

async function pickSkillDumpTarget(ctx: ExtensionCommandContext): Promise<SkillDumpTarget | undefined> {
  const selected = await selectModal(ctx, "Muon skill dump target", [
    { value: "pi", label: ".pi", description: `Write to ${getSkillDumpDestRoot(ctx.cwd, "pi")}` },
    { value: "agents", label: ".agents", description: `Write to ${getSkillDumpDestRoot(ctx.cwd, "agents")}` },
    { value: "claude", label: ".claude", description: `Write to ${getSkillDumpDestRoot(ctx.cwd, "claude")}` },
    { value: "codex", label: ".codex", description: `Write to ${getSkillDumpDestRoot(ctx.cwd, "codex")}` },
  ]);
  if (!selected || !isSkillDumpTarget(selected)) return undefined;
  return selected;
}

async function runSkillDump(ctx: ExtensionCommandContext, target: SkillDumpTarget | undefined): Promise<void> {
  const selected = target ?? (await pickSkillDumpTarget(ctx));
  if (!selected) return;

  const result = await dumpMuonSkills(ctx.cwd, selected);
  ctx.ui.notify(
    [
      `Dumped ${result.dumped.length} Muon skill(s) to ${result.destRoot}`,
      ...result.dumped.map((skill) => `- ${skill.name} -> ${skill.dest}`),
    ].join("\n"),
    "info",
  );
}

function sameSkillIds(a: readonly MuonSkillId[], b: readonly MuonSkillId[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function pathIsInside(path: string | undefined, root: string): boolean {
  if (!path) return false;
  const canonical = canonicalPath(path);
  const canonicalRoot = canonicalPath(root);
  if (!canonical || !canonicalRoot) return false;
  return canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}/`);
}

function displaySkillCommandName(commandName: string): string {
  return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSkillMdPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.endsWith("SKILL.md")) return path;
  const candidate = `${path.replace(/\/$/, "")}/SKILL.md`;
  return existsSync(candidate) ? candidate : path;
}

function openSkillInTmuxPopup(path: string | undefined): { ok: true } | { ok: false; reason: string } {
  const skillPath = resolveSkillMdPath(path);
  if (!process.env.TMUX) return { ok: false, reason: "No tmux detected" };
  if (!skillPath) return { ok: false, reason: "No SKILL.md path available for this external skill" };

  const child = spawn("tmux", [
    "display-popup",
    "-E",
    "-x",
    "C",
    "-y",
    "C",
    "-w",
    "98%",
    "-h",
    "95%",
    "-d",
    dirname(skillPath),
    `nvim ${shellQuote(skillPath)}`,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true };
}

function getManagedSkillRoots(): string[] {
  return resolveEnabledSkillPaths(MUON_SKILL_SOURCES.map((source) => source.id)).skillPaths;
}

function getExternalSkillCommands(pi: ExtensionAPI): Array<{ name: string; path?: string; scope?: string }> {
  const managedRoots = getManagedSkillRoots();
  const seen = new Set<string>();
  const external: Array<{ name: string; path?: string; scope?: string }> = [];

  for (const command of pi.getCommands().filter((candidate) => candidate.source === "skill")) {
    const path = command.sourceInfo.path;
    if (managedRoots.some((root) => pathIsInside(path, root))) continue;

    const name = displaySkillCommandName(command.name);
    const key = `${name}\0${path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    external.push({ name, path, scope: command.sourceInfo.scope });
  }

  return external.sort((a, b) => a.name.localeCompare(b.name));
}

function buildSkillsStatus(pi: ExtensionAPI, state: MuonState): string {
  const { skillPaths, missingSkillIds } = resolveEnabledSkillPaths(state.config.enabledSkills);
  const loadedSkillCommands = pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => `${command.name} [${command.sourceInfo.scope}]`)
    .sort();
  const externalSkillCommands = getExternalSkillCommands(pi);

  return [
    "Muon skills",
    `mode: ${state.config.mode}`,
    `enabled: ${formatEnabledSkills(state.config.enabledSkills)}`,
    "",
    "Known sources:",
    ...MUON_SKILL_SOURCES.map((source) => {
      const active = state.config.enabledSkills.includes(source.id) ? "on" : "off";
      const availability = resolveEnabledSkillPaths([source.id]).skillPaths.length > 0 ? "" : " (missing)";
      return `- ${source.id} (${source.kind}, ${active})${availability}: ${source.description}`;
    }),
    "",
    "Exposed skill roots after next reload:",
    ...(skillPaths.length > 0 ? skillPaths.map((path) => `- ${path}`) : ["- none"]),
    ...(missingSkillIds.length > 0 ? ["", `Missing enabled sources: ${missingSkillIds.join(", ")}`] : []),
    "",
    "Currently loaded skill commands (may include unmanaged Pi default/global skills):",
    ...(loadedSkillCommands.length > 0 ? loadedSkillCommands.map((name) => `- /${name}`) : ["- none"]),
    "",
    "External skills shown read-only in /muon skills:",
    ...(externalSkillCommands.length > 0
      ? externalSkillCommands.map((skill) => `- ${skill.name} [${skill.scope ?? "unknown"}]${skill.path ? ` ${skill.path}` : ""}`)
      : ["- none"]),
    "",
    "Note: Pi also auto-loads skills from trusted default locations such as ~/.pi/agent/skills, ~/.agents/skills, project .pi/skills, and project/ancestor .agents/skills. Muon lists those external skills as read-only because extensions cannot remove resources loaded by Pi's own discovery layer.",
  ].join("\n");
}

async function applyEnabledSkills(
  deps: MuonDeps,
  ctx: ExtensionCommandContext,
  next: MuonSkillId[],
  reason: string,
): Promise<void> {
  const state = deps.getState();
  const current = state.config.enabledSkills;
  const normalized = normalizeModeSkillIds(next, state.config.mode);
  if (sameSkillIds(current, normalized)) {
    ctx.ui.notify(`Muon skills unchanged: ${formatEnabledSkills(normalized)}`, "info");
    return;
  }
  deps.setState((draft) => {
    draft.config.enabledSkills = normalized;
  }, ctx);
  ctx.ui.notify(`Muon skills ${reason}: ${formatEnabledSkills(normalized)}. Reloading to apply…`, "info");
  await ctx.reload();
}

async function applyMode(deps: MuonDeps, ctx: ExtensionCommandContext, mode: MuonMode): Promise<void> {
  const state = deps.getState();
  const nextSkills = selectModeSkillIds(state.config.enabledSkills, mode);
  if (state.config.mode === mode && sameSkillIds(state.config.enabledSkills, nextSkills)) {
    ctx.ui.notify(`Muon mode is already ${mode}.`, "info");
    return;
  }

  deps.setState((draft) => {
    draft.config.mode = mode;
    draft.config.enabledSkills = nextSkills;
  }, ctx);
  ctx.ui.notify(`Muon mode set to ${mode}. Reloading to apply…`, "info");
  await ctx.reload();
}

async function showMuonSkillsToggle(pi: ExtensionAPI, deps: MuonDeps, ctx: ExtensionCommandContext): Promise<void> {
  const state = deps.getState();
  const initial = new Set(state.config.enabledSkills);
  const staged = new Set(state.config.enabledSkills);

  const result = await ctx.ui.custom<MuonSkillId[] | undefined>((tui, theme, _keybindings, done) => {
    const managedItems: SettingItem[] = MUON_SKILL_SOURCES.map((source) => {
      const available = resolveEnabledSkillPaths([source.id]).skillPaths.length > 0;
      const requiredByMode = state.config.mode === "spec" && source.id === "yagni-product-design";
      return {
        id: source.id,
        label: `${source.label}${source.kind === "profile" ? " (profile)" : ""}${available ? "" : " (missing)"}`,
        description: requiredByMode ? "Required by active spec mode" : undefined,
        currentValue: staged.has(source.id) ? "enabled" : "disabled",
        values: requiredByMode ? ["enabled"] : ["enabled", "disabled"],
      };
    });
    const externalItems: SettingItem[] = getExternalSkillCommands(pi).map((skill) => ({
      id: `external:${skill.name}:${skill.path ?? ""}`,
      label: `${skill.name} (external)`,
      description: skill.path ? `Open ${resolveSkillMdPath(skill.path)} in a tmux popup with Neovim` : "No SKILL.md path available",
      currentValue: "open",
      submenu: (_currentValue, close) => {
        const openResult = openSkillInTmuxPopup(skill.path);
        const message = openResult.ok ? `Opening ${skill.name} in tmux popup…` : openResult.reason;
        const color: "success" | "error" = openResult.ok ? "success" : "error";
        if (openResult.ok) setTimeout(() => close(undefined), 250);
        return {
          render: () => [theme.fg(color, message), theme.fg("dim", "Press Esc or Enter to return")],
          invalidate: () => {},
          handleInput: (data: string) => {
            if (data === "\r" || data === "\n" || data === "\x1b") close(undefined);
          },
        };
      },
    }));
    const items = [...managedItems, ...externalItems];

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Muon Skills")), 1, 0));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        // External skills are listed for visibility and can open their SKILL.md
        // in a tmux popup, but they are not toggleable because Pi discovered
        // them outside Muon's resource_discover scope.
        if (!isMuonSkillId(id)) return;
        if (newValue === "enabled") staged.add(id);
        else staged.delete(id);
      },
      () => done(Array.from(staged)),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter toggles managed skills or opens external skill • esc apply + reload"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "j" || data === "J") settingsList.handleInput?.("\x1b[B");
        else if (data === "k" || data === "K") settingsList.handleInput?.("\x1b[A");
        else settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });

  if (!result) return;
  const selected = new Set(result.filter((id) => initial.has(id) || isMuonSkillId(id)));
  const next = MUON_SKILL_SOURCES.map((source) => source.id).filter((id) => selected.has(id));
  await applyEnabledSkills(deps, ctx, next, "updated");
}

async function showMuonHelp(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Muon Help")), 1, 0));
      container.addChild(new Text(HELP_TEXT, 1, 1));
      container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to dismiss"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (data === "\r" || data === "\n" || data === "\x1b") done();
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", margin: 2 } },
  );
}

async function runMuonAction(pi: ExtensionAPI, deps: MuonDeps, ctx: ExtensionCommandContext, action: MuonAction): Promise<void> {
  const state = deps.getState();

  if (action.kind === "help") return showMuonHelp(ctx);
  if (action.kind === "skill-dump") return runSkillDump(ctx, action.target);

  if (action.kind === "mode") {
    if (action.status) {
      ctx.ui.notify(`Muon mode: ${state.config.mode}`, "info");
      return;
    }
    const mode = action.mode ?? (await showMuonModePicker(ctx, state.config.mode));
    if (mode) await applyMode(deps, ctx, mode);
    return;
  }

  if (action.kind === "status") {
    ctx.ui.notify(
      [
        "Muon status",
        `mode: ${state.config.mode}`,
        `skills: ${formatEnabledSkills(state.config.enabledSkills)}`,
        "",
        buildSkillsStatus(pi, state),
      ].join("\n"),
      "info",
    );
    return;
  }

  if (action.kind === "skills") {
    if (!action.op || action.op === "ui") {
      await showMuonSkillsToggle(pi, deps, ctx);
      return;
    }
    if (action.op === "status") {
      ctx.ui.notify(buildSkillsStatus(pi, state), "info");
      return;
    }
    if (action.op === "profile") {
      const profile = action.profile ?? "off";
      await applyEnabledSkills(deps, ctx, applySkillProfile(state.config.enabledSkills, profile), `profile set to ${profile}`);
      return;
    }
    if (!action.skillId) return;
    const next = new Set(state.config.enabledSkills);
    if (action.op === "on") next.add(action.skillId);
    if (action.op === "off") next.delete(action.skillId);
    if (action.op === "toggle") {
      if (next.has(action.skillId)) next.delete(action.skillId);
      else next.add(action.skillId);
    }
    const ordered = MUON_SKILL_SOURCES.map((source) => source.id).filter((id) => next.has(id));
    await applyEnabledSkills(deps, ctx, ordered, `${action.op} ${action.skillId}`);
  }
}

export function registerMuonCommands(pi: ExtensionAPI, deps: MuonDeps): void {
  pi.registerCommand("mus", {
    description: "Open Muon skill selection",
    handler: async (_args, ctx) => {
      await showMuonSkillsToggle(pi, deps, ctx);
    },
  });

  pi.registerCommand("muon", {
    description: "Open Muon menu",
    getArgumentCompletions: (prefix) => {
      const items = [
        "build",
        "spec",
        "off",
        "status",
        "mode",
        "skills",
        "skill-dump",
        "help"
      ];
      return items.filter((item) => item.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parsed = parseMuonAction(args || "", MUON_SKILL_SOURCES.map((source) => source.id)) as ParsedMuon;
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const action = parsed.kind === "menu" ? await pickMuonAction(ctx) : parsed.action;
      if (!action) return;
      await runMuonAction(pi, deps, ctx, action);
    },
  });
}
