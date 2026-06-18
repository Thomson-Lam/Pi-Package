import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guardToolCall } from "./guardrails.js";
import { buildPlanModePrompt } from "./prompt.js";
import { registerPlanModeCommands } from "./commands.js";
import { ensurePlanModeLayout } from "./storage.js";
import { createInitialState, persistState, restoreState, updateStatus } from "./state.js";
import type { PlanModeState } from "./types.js";
import { collectFreshnessNotifications, computePlanDiff, TOOL_DIFF_CHAR_LIMIT } from "./attachment.js";

export default async function planModeExtension(pi: ExtensionAPI): Promise<void> {
  await ensurePlanModeLayout();

  let state: PlanModeState = createInitialState();

  function getState(): PlanModeState {
    return state;
  }

  function setState(updater: (state: PlanModeState) => void, ctx: ExtensionContext): void {
    updater(state);
    persistState(pi, state);
    updateStatus(ctx, state);
  }

  registerPlanModeCommands(pi, { getState, setState });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx);
    await ensurePlanModeLayout({ mode: state.planStoreMode, cwd: ctx.cwd });
    updateStatus(ctx, state);
  });

  pi.on("before_agent_start", async (event) => {
    const notifications = await collectFreshnessNotifications(state);
    if (notifications.length > 0) persistState(pi, state);

    const systemPrompt = state.enabled ? `${event.systemPrompt}\n\n${buildPlanModePrompt(state)}` : event.systemPrompt;

    if (notifications.length === 0) {
      if (!state.enabled) return;
      return { systemPrompt };
    }

    const content = notifications.map((n) => n.content).join("\n\n");
    return {
      systemPrompt,
      message: {
        customType: "plan-change-notification",
        display: true,
        content,
        details: {
          kind: "plan-change-notification-batch",
          count: notifications.length,
          notifications: notifications.map((n) => n.details),
        },
      },
    };
  });

  pi.registerTool({
    name: "plan_diff",
    label: "Plan Diff",
    description: "Show diff between attached plan snapshot baseline and current on-disk file",
    parameters: Type.Object({
      planName: Type.Optional(Type.String({ description: "Plan name. Defaults to active attached plan." })),
    }),
    async execute(_toolCallId, params) {
      const requested = params.planName?.trim();
      const targetPlanName = requested || state.activeAttachedPlanName;
      if (!targetPlanName) {
        return {
          content: [{ type: "text", text: "No attached plan baseline found. Run /pattach <plan> first." }],
          details: { changed: false, missingBaseline: true },
          isError: true,
        };
      }

      const attachment = state.planAttachments[targetPlanName];
      if (!attachment) {
        return {
          content: [{ type: "text", text: `No attached baseline for plan '${targetPlanName}'. Run /pattach ${targetPlanName} first.` }],
          details: { planName: targetPlanName, changed: false, missingBaseline: true },
          isError: true,
        };
      }

      const result = await computePlanDiff(attachment);
      if (result.missing) {
        return {
          content: [{ type: "text", text: `Attached plan ${attachment.planName} no longer exists on disk.\nPath: ${attachment.planPath}` }],
          details: {
            planName: attachment.planName,
            attachedHash: attachment.attachedHash,
            currentHash: undefined,
            changed: true,
            missing: true,
          },
          isError: true,
        };
      }

      attachment.currentHash = result.currentHash;
      attachment.lastDiffReadHash = result.currentHash;
      persistState(pi, state);

      if (!result.changed) {
        return {
          content: [{ type: "text", text: `No changes for plan ${attachment.planName} since attached snapshot.\nPath: ${attachment.planPath}` }],
          details: {
            planName: attachment.planName,
            attachedHash: attachment.attachedHash,
            currentHash: result.currentHash,
            changed: false,
            diffChars: 0,
            truncated: false,
          },
        };
      }

      const truncated = result.diff.length > TOOL_DIFF_CHAR_LIMIT;
      const shownDiff = truncated ? `${result.diff.slice(0, TOOL_DIFF_CHAR_LIMIT)}\n\n... diff truncated ...` : result.diff;
      return {
        content: [
          {
            type: "text",
            text: `Diff for plan ${attachment.planName} since attached snapshot:\nPath: ${attachment.planPath}\n\n\`\`\`diff\n${shownDiff}\n\`\`\``,
          },
        ],
        details: {
          planName: attachment.planName,
          attachedHash: attachment.attachedHash,
          currentHash: result.currentHash,
          changed: true,
          diffChars: result.diff.length,
          truncated,
        },
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => guardToolCall(event, state, ctx.cwd));
}
