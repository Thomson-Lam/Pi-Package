import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "./model-resolver.js";
import type { IsolationMode, ThinkingLevel } from "./types.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ApprovalRequest {
  agentType: string;
  description: string;
  prompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  runInBackground: boolean;
  inheritContext: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  promptMode: "replace" | "append";
  contextLabel?: string;
  contextText?: string;
}

export type ApprovalResult =
  | { outcome: "launch"; prompt: string; model: Model<Api>; thinking: ThinkingLevel }
  | { outcome: "feedback"; feedback: string }
  | { outcome: "do-it-yourself"; prompt: string }
  | { outcome: "cancel" };

function modelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function availableThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  return [...new Set(THINKING_LEVELS.map((level) => clampThinkingLevel(model, level) as ThinkingLevel))];
}

function buildSummary(request: ApprovalRequest): string {
  const context = request.inheritContext
    ? "Inherited parent conversation snapshot (user/assistant text and summaries; tool results omitted)"
    : request.contextLabel ?? "Fresh conversation";

  return [
    `Approve subagent: ${request.description}`,
    "",
    `Agent: ${request.agentType}`,
    `Model: ${modelId(request.model)}`,
    `Reasoning: ${request.thinking}`,
    `Run mode: ${request.runInBackground ? "background" : "foreground"}`,
    `Conversation context: ${context}`,
    `System prompt: ${request.promptMode === "append" ? "inherits parent system prompt" : "standalone agent prompt"}`,
    `Extensions: ${request.isolated ? "isolated (built-ins only)" : "agent configuration"}`,
    `Filesystem: ${request.isolation === "worktree" ? "isolated worktree" : "parent working tree"}`,
    "",
    "Task prompt:",
    request.prompt,
  ].join("\n");
}

export async function approveInvocation(
  ctx: ExtensionContext,
  registry: ModelRegistry,
  initial: ApprovalRequest,
): Promise<ApprovalResult> {
  if (ctx.mode !== "tui") return { outcome: "cancel" };

  const request = { ...initial };

  for (;;) {
    const actions = [
      "Launch",
      "Edit child task",
      `Change model (${modelId(request.model)})`,
      `Change reasoning (${request.thinking})`,
      "Feedback to main agent",
      "Do it yourself",
    ];
    if (request.contextText) actions.push("View inherited context");
    actions.push("Cancel");

    const action = await ctx.ui.select(buildSummary(request), actions);
    if (!action || action === "Cancel") return { outcome: "cancel" };
    if (action === "Launch") {
      return { outcome: "launch", prompt: request.prompt, model: request.model, thinking: request.thinking };
    }
    if (action === "Edit child task") {
      const prompt = await ctx.ui.editor("Edit subagent task prompt", request.prompt);
      if (prompt?.trim()) request.prompt = prompt;
      continue;
    }
    if (action === "Feedback to main agent") {
      const feedback = await ctx.ui.editor("Feedback to the main agent", "");
      if (feedback?.trim()) return { outcome: "feedback", feedback: feedback.trim() };
      continue;
    }
    if (action === "Do it yourself") {
      return { outcome: "do-it-yourself", prompt: request.prompt };
    }
    if (action.startsWith("Change model")) {
      const models = (registry.getAvailable?.() ?? registry.getAll()) as Model<Api>[];
      const byId = new Map(models.map((model) => [modelId(model), model]));
      const selected = await ctx.ui.select("Select subagent model", [...byId.keys()].sort());
      const selectedModel = selected ? byId.get(selected) : undefined;
      if (selectedModel) {
        request.model = selectedModel;
        request.thinking = clampThinkingLevel(request.model, request.thinking) as ThinkingLevel;
      }
      continue;
    }
    if (action.startsWith("Change reasoning")) {
      const selected = await ctx.ui.select("Select subagent reasoning level", availableThinkingLevels(request.model));
      if (selected) request.thinking = selected as ThinkingLevel;
      continue;
    }
    if (action === "View inherited context" && request.contextText) {
      await ctx.ui.editor("Inherited context (view only; edits are discarded)", request.contextText);
    }
  }
}
