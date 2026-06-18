import fs from "node:fs";
import path from "node:path";

export interface PromptConfig {
  planModeSystemPrompt: string;
  reviewPrompt: string;
}

const DEFAULT_PROMPTS: PromptConfig = {
  planModeSystemPrompt:
    "You are in plan mode. Operate as a planning partner and only edit plan-store files under ~/.pi/agent/plan-mode.",
  reviewPrompt:
    "Review this implementation plan thoroughly for ambiguity, missing detail, testing, rollout concerns, and edge cases.\n\nPlan: {{planName}}\n\n{{planContent}}",
};

let cached: PromptConfig | null = null;

export function loadPromptConfig(): PromptConfig {
  if (cached) return cached;

  try {
    const promptsPath = path.join(__dirname, "prompts.json");
    const raw = fs.readFileSync(promptsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PromptConfig>;
    cached = {
      planModeSystemPrompt: parsed.planModeSystemPrompt ?? DEFAULT_PROMPTS.planModeSystemPrompt,
      reviewPrompt: parsed.reviewPrompt ?? DEFAULT_PROMPTS.reviewPrompt,
    };
  } catch {
    cached = DEFAULT_PROMPTS;
  }

  return cached;
}

export function renderPrompt(template: string, data: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_full, key) => data[key] ?? "");
}
