import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { reviewContextHandoff } from "./ui/context-review.js";
import {
  hasContextHandoffProblems,
  isContextHandoffEmpty,
  type ContextProblem,
  type PreparedContextHandoff,
} from "./handoff/types.js";
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
  /** Prepared constrained-context packet (resolved before review). */
  handoff?: PreparedContextHandoff;
}

export type ApprovalResult =
  | { outcome: "launch"; prompt: string; model: Model<Api>; thinking: ThinkingLevel; handoff?: PreparedContextHandoff }
  | { outcome: "feedback"; feedback: string }
  | { outcome: "do-it-yourself"; prompt: string }
  | { outcome: "cancel" };

function modelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function availableThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  return [...new Set(THINKING_LEVELS.map((level) => clampThinkingLevel(model, level) as ThinkingLevel))];
}

async function selectSubagentModel(
  ctx: ExtensionContext,
  models: Model<Api>[],
  current: Model<Api>,
): Promise<Model<Api> | undefined> {
  const choices = [...new Map(models.map((model) => [modelId(model), model])).entries()]
    .map(([id, model]) => ({ id, model }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) => {
    const input = new Input();
    let filtered = choices;
    let selectedIndex = Math.max(0, choices.findIndex((choice) => choice.id === modelId(current)));
    let searchMode = false;
    let committedQuery = "";
    let queryBeforeSearch = "";
    let selectionBeforeSearch = choices[selectedIndex]?.id;
    let regexError: string | undefined;
    let focused = false;

    const applyFilter = (query: string, preferredId?: string) => {
      regexError = undefined;
      if (!query) {
        filtered = choices;
      } else {
        try {
          const regex = new RegExp(query, "i");
          filtered = choices.filter(({ id, model }) => regex.test(`${id} ${model.name ?? ""}`));
        } catch (error) {
          filtered = [];
          regexError = error instanceof Error ? error.message : String(error);
        }
      }
      const preferredIndex = preferredId ? filtered.findIndex((choice) => choice.id === preferredId) : -1;
      selectedIndex = preferredIndex >= 0 ? preferredIndex : Math.min(selectedIndex, Math.max(0, filtered.length - 1));
    };

    const moveSelection = (delta: number) => {
      if (filtered.length === 0) return;
      selectedIndex = Math.max(0, Math.min(filtered.length - 1, selectedIndex + delta));
    };

    const component = {
      get focused() { return focused; },
      set focused(value: boolean) {
        focused = value;
        input.focused = value && searchMode;
      },
      invalidate() { input.invalidate(); },
      render(width: number): string[] {
        const lines = [theme.fg("accent", theme.bold("Select subagent model"))];
        if (searchMode) {
          lines.push(theme.fg("muted", "Regex search:"), ...input.render(width));
        } else {
          const filter = committedQuery ? `Filter: /${committedQuery}/` : "/ regex search";
          lines.push(theme.fg("muted", filter), "");
        }
        lines.push("");

        const maxVisible = 10;
        const modelLines: string[] = [];
        if (regexError) {
          modelLines.push(theme.fg("error", truncateToWidth(`Invalid regex: ${regexError}`, width, "…")));
        } else if (filtered.length === 0) {
          modelLines.push(theme.fg("muted", "  No matching models"));
        } else {
          const start = Math.max(0, Math.min(
            selectedIndex - Math.floor(maxVisible / 2),
            filtered.length - maxVisible,
          ));
          const end = Math.min(start + maxVisible, filtered.length);
          for (let i = start; i < end; i++) {
            const choice = filtered[i]!;
            const selected = i === selectedIndex;
            const name = choice.model.name && choice.model.name !== choice.model.id
              ? ` — ${choice.model.name}`
              : "";
            const line = `${selected ? "→ " : "  "}${choice.id}${name}`;
            modelLines.push(truncateToWidth(
              selected ? theme.fg("accent", line) : theme.fg("text", line),
              width,
              "…",
            ));
          }
        }
        while (modelLines.length < maxVisible) modelLines.push("");
        lines.push(...modelLines);
        lines.push(filtered.length > maxVisible
          ? theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`)
          : "");

        lines.push("");
        const cancelHint = committedQuery ? "esc clear filter" : "esc cancel";
        lines.push(theme.fg(
          "dim",
          searchMode
            ? "↑/↓ move  page up/down  enter apply  esc cancel search  ctrl+c cancel"
            : `j/k move  h/l page  / search  enter select  ${cancelHint}`,
        ));
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (searchMode) {
          if (data === "escape") {
            searchMode = false;
            input.setValue(queryBeforeSearch);
            input.focused = false;
            applyFilter(queryBeforeSearch, selectionBeforeSearch);
          } else if (keybindings.matches(data, "tui.select.cancel")) {
            done(undefined);
            return;
          } else if (keybindings.matches(data, "tui.select.up")) {
            moveSelection(-1);
          } else if (keybindings.matches(data, "tui.select.down")) {
            moveSelection(1);
          } else if (keybindings.matches(data, "tui.select.pageUp")) {
            moveSelection(-10);
          } else if (keybindings.matches(data, "tui.select.pageDown")) {
            moveSelection(10);
          } else if (keybindings.matches(data, "tui.input.submit")) {
            if (!regexError) {
              committedQuery = input.getValue();
              searchMode = false;
              input.focused = false;
            }
          } else {
            const preferredId = filtered[selectedIndex]?.id;
            input.handleInput(data);
            applyFilter(input.getValue(), preferredId);
          }
          tui.requestRender();
          return;
        }

        if (data === "/") {
          searchMode = true;
          queryBeforeSearch = committedQuery;
          selectionBeforeSearch = filtered[selectedIndex]?.id;
          input.setValue(committedQuery);
          input.focused = focused;
        } else if (data === "k" || keybindings.matches(data, "tui.select.up")) {
          moveSelection(-1);
        } else if (data === "j" || keybindings.matches(data, "tui.select.down")) {
          moveSelection(1);
        } else if (data === "h" || keybindings.matches(data, "tui.select.pageUp")) {
          moveSelection(-10);
        } else if (data === "l" || keybindings.matches(data, "tui.select.pageDown")) {
          moveSelection(10);
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          const selected = filtered[selectedIndex];
          if (selected) done(selected.model);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          if (committedQuery) {
            const preferredId = filtered[selectedIndex]?.id;
            committedQuery = "";
            input.setValue("");
            applyFilter("", preferredId);
          } else {
            done(undefined);
            return;
          }
        }
        tui.requestRender();
      },
    };
    return component;
  });
}

function buildSummary(request: ApprovalRequest): string {
  const context = request.inheritContext
    ? "Inherited parent conversation snapshot (user/assistant text and summaries; tool results omitted)"
    : request.contextLabel ?? "Fresh conversation";

  const lines = [
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
  ];

  if (request.handoff) {
    const handoff = request.handoff;
    const problems =
      handoff.snippetProblems.length + handoff.leadProblems.length + handoff.packetProblems.length;
    lines.push(
      `Context packet: ${handoff.snippets.length} evidence snippet(s) · ${handoff.recommendedFiles.length} recommended file(s) · est. ${handoff.estimatedTokens} tokens`,
    );
    if (problems > 0) {
      lines.push(`Context problems: ${problems} item(s) need attention before launch (see Review context)`);
    }
    if (request.inheritContext) {
      lines.push("Warning: inherit_context plus a context packet may duplicate content — confirm this is intentional.");
    }
  }

  return lines.join("\n");
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
      "Review / edit task prompt",
      "Launch",
      `Change model (${modelId(request.model)})`,
      `Change reasoning (${request.thinking})`,
      "Feedback to main agent",
      "Do it yourself",
    ];
    if (request.handoff && !isContextHandoffEmpty(request.handoff)) {
      const handoff = request.handoff;
      const problems =
        handoff.snippetProblems.length + handoff.leadProblems.length + handoff.packetProblems.length;
      actions.splice(
        1,
        0,
        `Review context (${handoff.snippets.length} snippet${handoff.snippets.length === 1 ? "" : "s"} · ${handoff.recommendedFiles.length} lead${handoff.recommendedFiles.length === 1 ? "" : "s"} · est. ${handoff.estimatedTokens} tokens${problems > 0 ? ` · ⚠ ${problems} problem${problems === 1 ? "" : "s"}` : ""})`,
      );
    }
    if (request.contextText) actions.push("View inherited context");
    actions.push("Cancel");

    const action = await ctx.ui.select(buildSummary(request), actions);
    if (!action || action === "Cancel") return { outcome: "cancel" };
    if (action === "Launch") {
      if (request.handoff && hasContextHandoffProblems(request.handoff)) {
        // Decision #2: problems route back to the main agent as feedback so it
        // can correct the proposal and retry, without the human re-prompting.
        return { outcome: "feedback", feedback: buildContextProblemReport(request.handoff) };
      }
      return { outcome: "launch", prompt: request.prompt, model: request.model, thinking: request.thinking, handoff: request.handoff };
    }
    if (action === "Review / edit task prompt") {
      const prompt = await ctx.ui.editor("Review subagent task prompt", request.prompt);
      if (prompt?.trim()) request.prompt = prompt;
      continue;
    }
    if (action.startsWith("Review context") && request.handoff) {
      const review = await reviewContextHandoff(ctx, request.handoff);
      // A cancelled review aborts the whole approval — Launch must never run.
      if (review.cancelled) return { outcome: "cancel" };
      request.handoff = review.prepared;
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
      const selectedModel = await selectSubagentModel(ctx, models, request.model);
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

/** Render one problem for the feedback report. */
function describeProblem(problem: ContextProblem): string {
  if (problem.snippet) {
    return `${problem.snippet.path}:${problem.snippet.startLine}-${problem.snippet.endLine}: ${problem.kind} — ${problem.message}`;
  }
  if (problem.lead) {
    return `${problem.lead.path}: ${problem.kind} — ${problem.message}`;
  }
  return `packet: ${problem.kind} — ${problem.message}`;
}

/** Structured report the main agent receives when problems block launch. */
function buildContextProblemReport(handoff: PreparedContextHandoff): string {
  const problems = [
    ...handoff.snippetProblems,
    ...handoff.leadProblems,
    ...handoff.packetProblems,
  ];
  const lines = [
    "The subagent proposal has context problems that must be fixed before it can launch:",
    ...problems.map((problem) => `- ${describeProblem(problem)}`),
    "",
    "Fix or remove the failing context references and retry the Agent call, or omit context for a fresh launch.",
  ];
  return lines.join("\n");
}
