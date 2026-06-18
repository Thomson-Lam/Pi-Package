import fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectFreshnessNotifications, createAttachment } from "./attachment.js";

import { openInEditor } from "./editor.js";
import { loadPromptConfig, renderPrompt } from "./prompts.js";
import { pickItemWithVimNav, pickListAction } from "./ui-picker.js";
import {
  createPlan,
  createPlanAtPath,
  createSuModule,
  ensurePlanModeLayout,
  fileExists,
  getPlanModeRoot,
  getPlanPath,
  getSuModulePath,
  isPlanPathArg,
  listPlans,
  listSuModules,
  normalizePlanName,
  normalizeSuModuleName,
  registerPlanLocation,
  removePlanLocation,
  resolveDefaultPlanName,
  resolvePlanFilePath,
  touchRecentPlan,
} from "./storage.js";
import type { PlanModeState } from "./types.js";

interface CommandDeps {
  getState: () => PlanModeState;
  setState: (updater: (state: PlanModeState) => void, ctx: ExtensionCommandContext) => void;
}

function getRepoPrefix(cwd: string): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "repo";
  const sanitized = base.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "-");
  return sanitized || "repo";
}

function withRepoPrefix(name: string, repoPrefix: string): string {
  const normalized = normalizePlanName(name);
  return normalized.startsWith(`${repoPrefix}_`) || normalized.startsWith(`${repoPrefix}__`)
    ? normalized
    : `${repoPrefix}_${normalized}`;
}

function storeOptions(state: PlanModeState, ctx: ExtensionCommandContext) {
  return { mode: state.planStoreMode, cwd: ctx.cwd } as const;
}

async function resolvedPlanPath(planName: string, state: PlanModeState, ctx: ExtensionCommandContext): Promise<string> {
  return resolvePlanFilePath(planName, storeOptions(state, ctx), state.planLocations);
}

async function resolvePlanName(args: string, state: PlanModeState, ctx: ExtensionCommandContext): Promise<string> {
  const name = args.trim() || (await resolveDefaultPlanName(state.currentPlanName, storeOptions(state, ctx), state.planLocations));
  if (!name) throw new Error("No plan found");
  return normalizePlanName(name);
}

async function resolveScopedPlanName(args: string, state: PlanModeState, ctx: ExtensionCommandContext): Promise<string> {
  const requested = args.trim();
  const repoPrefix = getRepoPrefix(ctx.cwd);
  const options = storeOptions(state, ctx);

  if (!requested) {
    if (state.currentPlanName) {
      const current = normalizePlanName(state.currentPlanName);
      if (await fileExists(await resolvedPlanPath(current, state, ctx))) return current;
    }
    const repoPlans = (await listPlans(options, state.planLocations)).filter(
      (plan) => plan.name.startsWith(`${repoPrefix}_`) || plan.name.startsWith(`${repoPrefix}__`),
    );
    if (repoPlans.length > 0) return repoPlans[0].name;
    return resolvePlanName(args, state, ctx);
  }

  const prefixed = withRepoPrefix(requested, repoPrefix);
  if (await fileExists(await resolvedPlanPath(prefixed, state, ctx))) return prefixed;

  const normalizedRaw = normalizePlanName(requested);
  if (await fileExists(await resolvedPlanPath(normalizedRaw, state, ctx))) return normalizedRaw;

  throw new Error(`Plan not found: ${requested}`);
}

async function resolveScopedSuModuleName(args: string, state: PlanModeState, ctx: ExtensionCommandContext): Promise<string> {
  const requested = args.trim();
  const repoPrefix = getRepoPrefix(ctx.cwd);
  const options = storeOptions(state, ctx);

  if (!requested) {
    const modules = await listSuModules(options);
    if (modules.length === 0) throw new Error("No SuModules found");
    const scoped = modules.find(
      (item) => item.name.startsWith(`${repoPrefix}_`) || item.name.startsWith(`${repoPrefix}__`),
    );
    return scoped?.name ?? modules[0].name;
  }

  const prefixed = withRepoPrefix(requested, repoPrefix);
  if (await fileExists(getSuModulePath(prefixed, options))) return prefixed;

  const normalizedRaw = normalizeSuModuleName(requested);
  if (await fileExists(getSuModulePath(normalizedRaw, options))) return normalizedRaw;

  throw new Error(`SuModule not found: ${requested}`);
}

async function openPlanFile(planPath: string, ctx: ExtensionCommandContext): Promise<void> {
  const editor = await openInEditor(planPath);
  if (!editor.opened) {
    ctx.ui.notify(`Plan ready at ${planPath} (${editor.reason})`, "info");
  }
}

async function attachPlanToSession(
  pi: ExtensionAPI,
  deps: CommandDeps,
  ctx: ExtensionCommandContext,
  planName: string,
): Promise<void> {
  const state = deps.getState();
  const planPath = await resolvedPlanPath(planName, state, ctx);
  const content = await fs.readFile(planPath, "utf8");
  const attachment = createAttachment(planName, planPath, content);
  await touchRecentPlan(planName, storeOptions(state, ctx));
  deps.setState((draft) => {
    draft.currentPlanName = planName;
    draft.activeAttachedPlanName = planName;
    draft.planAttachments[planName] = attachment;
    draft.planLocations[planName] = {
      name: planName,
      path: planPath,
      kind: planPath === getPlanPath(planName, storeOptions(draft, ctx)) ? "store" : "explicitPath",
      createdAt: draft.planLocations[planName]?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }, ctx);
  pi.sendMessage(
    {
      customType: "plan-attachment",
      display: true,
      content: `Attached plan: ${planName}\nPath: ${planPath}\n\n--- BEGIN PLAN ---\n${content}\n--- END PLAN ---`,
      details: {
        kind: "plan-snapshot",
        planName,
        planPath,
        contentHash: attachment.attachedHash,
        attachedAt: attachment.attachedAt,
      },
    },
    { triggerTurn: false },
  );
}

export function registerPlanModeCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("plan", {
    description: "Plan mode control: /plan on|off|status",
    handler: async (args, ctx) => {
      const state = deps.getState();
      const action = args.trim();
      if (action === "on") {
        deps.setState((draft) => {
          draft.enabled = true;
        }, ctx);
        ctx.ui.notify("Plan mode enabled", "success");
        return;
      }
      if (action === "off") {
        deps.setState((draft) => {
          draft.enabled = false;
        }, ctx);
        ctx.ui.notify("Plan mode disabled", "info");
        return;
      }

      ctx.ui.notify(
        `plan mode: ${state.enabled ? "on" : "off"}\ncurrent plan: ${state.currentPlanName ?? "—"}\nstore mode: ${state.planStoreMode}\nstore root: ${getPlanModeRoot(storeOptions(state, ctx))}`,
        "info",
      );
    },
  });

  pi.registerCommand("plan-store", {
    description: "Plan storage: /plan-store global|repo|status",
    handler: async (args, ctx) => {
      const action = args.trim();
      const state = deps.getState();
      if (!action || action === "status") {
        ctx.ui.notify(
          `plan store mode: ${state.planStoreMode}\nroot: ${getPlanModeRoot(storeOptions(state, ctx))}`,
          "info",
        );
        return;
      }
      if (action !== "global" && action !== "repo") throw new Error("Usage: /plan-store global|repo|status");
      deps.setState((draft) => {
        draft.planStoreMode = action;
      }, ctx);
      await ensurePlanModeLayout({ mode: action, cwd: ctx.cwd });
      ctx.ui.notify(`Plan store set to ${action}: ${getPlanModeRoot({ mode: action, cwd: ctx.cwd })}`, "success");
    },
  });

  pi.registerCommand("pnew", {
    description: "Create a new plan file. Use /pnew name or /pnew docs/plans/name.md",
    handler: async (args, ctx) => {
      const rawName = args.trim();
      if (!rawName) throw new Error("Usage: /pnew <name|repo-relative-path.md>");
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      let name: string;
      let planPath: string;
      if (isPlanPathArg(rawName)) {
        const created = await createPlanAtPath(rawName, { ...options, cwd: ctx.cwd });
        name = created.name;
        planPath = created.path;
      } else {
        const repoPrefix = getRepoPrefix(ctx.cwd);
        name = withRepoPrefix(rawName, repoPrefix);
        planPath = await createPlan(name, options);
      }
      const location = await registerPlanLocation(name, planPath, isPlanPathArg(rawName) ? "explicitPath" : "store", options);
      await touchRecentPlan(name, options);
      deps.setState((draft) => {
        draft.currentPlanName = name;
        draft.planLocations[name] = location;
      }, ctx);
      await openPlanFile(planPath, ctx);
      ctx.ui.notify(`Created plan: ${name}\n${planPath}`, "success");
    },
  });

  pi.registerCommand("popen", {
    description: "Open a global plan file",
    handler: async (args, ctx) => {
      const state = deps.getState();
      const name = await resolveScopedPlanName(args, state, ctx);
      const planPath = await resolvedPlanPath(name, state, ctx);
      if (!(await fileExists(planPath))) throw new Error(`Plan not found: ${name}`);
      await touchRecentPlan(name, storeOptions(state, ctx));
      deps.setState((draft) => {
        draft.currentPlanName = name;
        draft.planLocations[name] = {
          name,
          path: planPath,
          kind: planPath === getPlanPath(name, storeOptions(draft, ctx)) ? "store" : "explicitPath",
          createdAt: draft.planLocations[name]?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
      }, ctx);
      await openPlanFile(planPath, ctx);
      ctx.ui.notify(`Opened plan: ${name}`, "success");
    },
  });

  pi.registerCommand("plist", {
    description: "Show available plans for this repo",
    handler: async (_args, ctx) => {
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      const repoPrefix = getRepoPrefix(ctx.cwd);
      const prefixA = `${repoPrefix}_`;
      const prefixB = `${repoPrefix}__`;
      const plans = (await listPlans(options, state.planLocations)).filter(
        (plan) => plan.name.startsWith(prefixA) || plan.name.startsWith(prefixB),
      );
      if (plans.length === 0) {
        ctx.ui.notify(`No plans found for repo prefix: ${prefixA}`, "info");
        return;
      }

      const escapedPrefix = repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      while (true) {
        const freshPlans = (await listPlans(options, state.planLocations)).filter(
          (plan) => plan.name.startsWith(prefixA) || plan.name.startsWith(prefixB),
        );
        if (freshPlans.length === 0) {
          ctx.ui.notify(`No plans found for repo prefix: ${prefixA}`, "info");
          return;
        }

        const labelToPlan = new Map(
          freshPlans.map((plan) => [plan.name.replace(new RegExp(`^${escapedPrefix}__?`), ""), plan.name] as const),
        );
        const selectedLabel = await pickItemWithVimNav(ctx, `Plans (${repoPrefix})`, [...labelToPlan.keys()]);
        if (!selectedLabel) return;

        const fullName = labelToPlan.get(selectedLabel) ?? selectedLabel;
        const action = await pickListAction(ctx, `Plan: ${selectedLabel}`, ["Open", "Attach", "Delete", "Cancel"]);
        if (!action || action === "Cancel") return;
        if (action === "Back") continue;

        if (action === "Attach") {
          await attachPlanToSession(pi, deps, ctx, fullName);
          ctx.ui.notify(`Attached plan: ${fullName}`, "success");
          return;
        }

        if (action === "Delete") {
          const ok = await ctx.ui.confirm("Delete plan", `Delete plan '${fullName}'? This cannot be undone.`);
          if (!ok) continue;
          await fs.unlink(await resolvedPlanPath(fullName, deps.getState(), ctx));
          await removePlanLocation(fullName, options);
          ctx.ui.notify(`Deleted plan: ${fullName}`, "success");
          const state = deps.getState();
          deps.setState((draft) => {
            delete draft.planLocations[fullName];
            delete draft.planAttachments[fullName];
            if (state.currentPlanName === fullName) draft.currentPlanName = undefined;
            if (state.activeAttachedPlanName === fullName) draft.activeAttachedPlanName = undefined;
          }, ctx);
          continue;
        }

        deps.setState((draft) => {
          draft.currentPlanName = fullName;
        }, ctx);
        await openPlanFile(await resolvedPlanPath(fullName, deps.getState(), ctx), ctx);
        ctx.ui.notify(`Opened plan: ${fullName}`, "success");
        return;
      }
    },
  });

  pi.registerCommand("plist-global", {
    description: "Show all plans in the active store",
    handler: async (_args, ctx) => {
      while (true) {
        const state = deps.getState();
        const options = storeOptions(state, ctx);
        const plans = await listPlans(options, state.planLocations);
        if (plans.length === 0) {
          ctx.ui.notify("No plans found", "info");
          return;
        }

        const selected = await pickItemWithVimNav(ctx, `Plans (${state.planStoreMode})`, plans.map((plan) => plan.name));
        if (!selected) return;

        const action = await pickListAction(ctx, `Plan: ${selected}`, ["Open", "Attach", "Delete", "Cancel"]);
        if (!action || action === "Cancel") return;
        if (action === "Back") continue;

        if (action === "Attach") {
          await attachPlanToSession(pi, deps, ctx, selected);
          ctx.ui.notify(`Attached plan: ${selected}`, "success");
          return;
        }

        if (action === "Delete") {
          const ok = await ctx.ui.confirm("Delete plan", `Delete plan '${selected}'? This cannot be undone.`);
          if (!ok) continue;
          await fs.unlink(await resolvedPlanPath(selected, deps.getState(), ctx));
          await removePlanLocation(selected, options);
          const state = deps.getState();
          deps.setState((draft) => {
            delete draft.planLocations[selected];
            delete draft.planAttachments[selected];
            if (state.currentPlanName === selected) draft.currentPlanName = undefined;
            if (state.activeAttachedPlanName === selected) draft.activeAttachedPlanName = undefined;
          }, ctx);
          ctx.ui.notify(`Deleted plan: ${selected}`, "success");
          continue;
        }

        deps.setState((draft) => {
          draft.currentPlanName = selected;
        }, ctx);
        await openPlanFile(await resolvedPlanPath(selected, deps.getState(), ctx), ctx);
        ctx.ui.notify(`Opened plan: ${selected}`, "success");
        return;
      }
    },
  });

  pi.registerCommand("pattach", {
    description: "Attach a full plan document to the current session",
    handler: async (args, ctx) => {
      const name = await resolveScopedPlanName(args, deps.getState(), ctx);
      await attachPlanToSession(pi, deps, ctx, name);
    },
  });

  pi.registerCommand("p-review", {
    description: "Ask the agent to review a plan document",
    handler: async (args, ctx) => {
      const state = deps.getState();
      const name = await resolveScopedPlanName(args, state, ctx);
      const planPath = await resolvedPlanPath(name, state, ctx);
      const content = await fs.readFile(planPath, "utf8");
      await touchRecentPlan(name, storeOptions(state, ctx));
      deps.setState((draft) => {
        draft.currentPlanName = name;
      }, ctx);
      const prompts = loadPromptConfig();
      const reviewText = renderPrompt(prompts.reviewPrompt, {
        planName: name,
        planContent: content,
      });
      pi.sendUserMessage(reviewText);
    },
  });

  pi.registerCommand("su-glist", {
    description: "List all SuModules in the active store",
    handler: async (_args, ctx) => {
      while (true) {
        const state = deps.getState();
        const options = storeOptions(state, ctx);
        const modules = await listSuModules(options);
        if (modules.length === 0) {
          ctx.ui.notify("No SuModules found", "info");
          return;
        }

        const selected = await pickItemWithVimNav(ctx, `SuModules (${state.planStoreMode})`, modules.map((item) => item.name));
        if (!selected) return;

        const action = await pickListAction(ctx, `SuModule: ${selected}`, ["Open", "Delete", "Cancel"]);
        if (!action || action === "Cancel") return;
        if (action === "Back") continue;

        if (action === "Delete") {
          const ok = await ctx.ui.confirm("Delete SuModule", `Delete SuModule '${selected}'? This cannot be undone.`);
          if (!ok) continue;
          await fs.unlink(getSuModulePath(selected, options));
          deps.setState((draft) => {
            draft.activeSuModules = draft.activeSuModules.filter((name) => name !== selected);
          }, ctx);
          ctx.ui.notify(`Deleted SuModule: ${selected}`, "success");
          continue;
        }

        await openPlanFile(getSuModulePath(selected, options), ctx);
        ctx.ui.notify(`Opened SuModule: ${selected}`, "success");
        return;
      }
    },
  });

  pi.registerCommand("su-list", {
    description: "List project-scoped SuModules",
    handler: async (_args, ctx) => {
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      const repoPrefix = getRepoPrefix(ctx.cwd);
      const prefixA = `${repoPrefix}_`;
      const prefixB = `${repoPrefix}__`;
      const escapedPrefix = repoPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      while (true) {
        const modules = (await listSuModules(options)).filter(
          (item) => item.name.startsWith(prefixA) || item.name.startsWith(prefixB),
        );
        if (modules.length === 0) {
          ctx.ui.notify(`No project SuModules found for prefix: ${prefixA}`, "info");
          return;
        }

        const labelToModule = new Map(
          modules.map((item) => [item.name.replace(new RegExp(`^${escapedPrefix}__?`), ""), item.name] as const),
        );
        const selectedLabel = await pickItemWithVimNav(ctx, `Project SuModules (${repoPrefix})`, [...labelToModule.keys()]);
        if (!selectedLabel) return;
        const fullName = labelToModule.get(selectedLabel) ?? selectedLabel;

        const action = await pickListAction(ctx, `SuModule: ${selectedLabel}`, ["Open", "Delete", "Cancel"]);
        if (!action || action === "Cancel") return;
        if (action === "Back") continue;

        if (action === "Delete") {
          const ok = await ctx.ui.confirm("Delete SuModule", `Delete SuModule '${fullName}'? This cannot be undone.`);
          if (!ok) continue;
          await fs.unlink(getSuModulePath(fullName, options));
          deps.setState((draft) => {
            draft.activeSuModules = draft.activeSuModules.filter((name) => name !== fullName);
          }, ctx);
          ctx.ui.notify(`Deleted SuModule: ${fullName}`, "success");
          continue;
        }

        await openPlanFile(getSuModulePath(fullName, options), ctx);
        ctx.ui.notify(`Opened SuModule: ${fullName}`, "success");
        return;
      }
    },
  });

  pi.registerCommand("su-new", {
    description: "Create a new SuModule",
    handler: async (args, ctx) => {
      const rawName = args.trim();
      if (!rawName) throw new Error("Usage: /su-new <name>");
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      const repoPrefix = getRepoPrefix(ctx.cwd);
      const name = withRepoPrefix(rawName, repoPrefix);
      const filePath = await createSuModule(name, options);
      await openPlanFile(filePath, ctx);
      ctx.ui.notify(`Created SuModule: ${name}`, "success");
    },
  });

  pi.registerCommand("su-open", {
    description: "Open a SuModule",
    handler: async (args, ctx) => {
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      const name = normalizeSuModuleName(args.trim());
      const filePath = getSuModulePath(name, options);
      if (!(await fileExists(filePath))) throw new Error(`SuModule not found: ${name}`);
      await openPlanFile(filePath, ctx);
      ctx.ui.notify(`Opened SuModule: ${name}`, "success");
    },
  });

  pi.registerCommand("su-apply", {
    description: "Append a SuModule to the latest plan document",
    handler: async (args, ctx) => {
      const state = deps.getState();
      const options = storeOptions(state, ctx);
      const moduleName = await resolveScopedSuModuleName(args, state, ctx);
      const planName = await resolveScopedPlanName("", state, ctx);

      const modulePath = getSuModulePath(moduleName, options);
      const planPath = await resolvedPlanPath(planName, state, ctx);
      if (!(await fileExists(modulePath))) throw new Error(`SuModule not found: ${moduleName}`);
      if (!(await fileExists(planPath))) throw new Error(`Plan not found: ${planName}`);

      const moduleContent = (await fs.readFile(modulePath, "utf8")).trim();
      const existingPlan = await fs.readFile(planPath, "utf8");
      const sectionHeader = `## SuModule: ${moduleName}`;
      if (existingPlan.includes(sectionHeader)) {
        ctx.ui.notify(`SuModule already applied: ${moduleName} -> ${planName}`, "info");
        return;
      }

      const appended = `${existingPlan.trimEnd()}\n\n${sectionHeader}\n\n${moduleContent}\n`;
      await fs.writeFile(planPath, appended, "utf8");
      await touchRecentPlan(planName, options);
      deps.setState((draft) => {
        draft.currentPlanName = planName;
        if (!draft.activeSuModules.includes(moduleName)) draft.activeSuModules.push(moduleName);
      }, ctx);

      const notifications = await collectFreshnessNotifications(deps.getState());
      for (const notification of notifications) {
        pi.sendMessage(
          {
            customType: "plan-change-notification",
            display: true,
            content: notification.content,
            details: notification.details,
          },
          { triggerTurn: false },
        );
      }

      ctx.ui.notify(`Applied SuModule ${moduleName} to plan ${planName}`, "success");
    },
  });

  void ensurePlanModeLayout();
}
