import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { ContextLedgerNode } from "./context-ledger.js";
import type { ModelRegistry } from "./model-resolver.js";
import { buildContextUI } from "./ui/context-selection.js";
import type { ThinkingLevel } from "./types.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ApprovalRequest {
  agentType: string;
  description: string;
  prompt: string;
  model: Model<Api>;
  thinking: ThinkingLevel;
  runInBackground: boolean;
}

/** Context already built by the human (from the context-building flow). */
export interface BuiltLedgerContext {
  selectedIds: string[];
  summary?: string;
  /** Inherited prior ledger nodes, ROOT→LEAF (empty = independent subtree). */
  inheritedNodes: ContextLedgerNode[];
}

/** Inputs the caller supplies so the approval flow can build a context ledger. */
export interface ApprovalContextInput {
  /** Current session branch entries (selectable rows are derived from these). */
  branch: SessionEntry[];
  /**
   * Inheritable prior ledger nodes, NEAREST first. Empty when there is nothing
   * to inherit — the inherit question is then skipped entirely (dead UI would
   * be noise; the approval summary surfaces "prior ledger available" instead).
   */
  candidates: ContextLedgerNode[];
  /**
   * Root→leaf ledger chain pre-selected for inheritance (used by /ot
   * "Launch agent with this context"). The inherit question is skipped and
   * the tree defaults these on.
   */
  presetInherited?: ContextLedgerNode[];
  /**
   * Opens the /ot context tree in select mode and resolves the inherited
   * ledger node chain (root→leaf) that the new context extends. Resolves []
   * when nothing was kept, undefined when the tree could not be opened.
   */
  openInheritTree?(initialIds: string[]): Promise<ContextLedgerNode[] | undefined>;
  summarize(
    branch: SessionEntry[],
    selectedIds: string[],
    model: unknown,
    thinking: ThinkingLevel | undefined,
    customInstructions?: string,
  ): Promise<string>;
}

export type ApprovalResult =
  | { outcome: "launch"; prompt: string; model: Model<Api>; thinking: ThinkingLevel; context?: BuiltLedgerContext }
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

function buildSummary(request: ApprovalRequest, built?: BuiltLedgerContext, inheritable = false): string {
  const parts: string[] = [];
  if (built?.inheritedNodes.length) {
    parts.push(`inherit ${built.inheritedNodes.length} upstream node${built.inheritedNodes.length === 1 ? "" : "s"}`);
  }
  if (built?.selectedIds.length) {
    parts.push(`${built.selectedIds.length} message${built.selectedIds.length === 1 ? "" : "s"} selected`);
  }
  if (built?.summary) parts.push("full-conversation compacted");
  if (built && parts.length === 0) parts.push("nothing selected");
  let contextLine = parts.length > 0 ? `Context: ${parts.join(" · ")}` : "Context: isolated (fresh child task only)";
  if (!built && inheritable) contextLine += " · prior ledger available (Build context ledger to inherit)";
  return [
    `Approve subagent: ${request.description}`,
    "",
    `Agent: ${request.agentType}`,
    `Model: ${modelId(request.model)}`,
    `Reasoning: ${request.thinking}`,
    `Run mode: ${request.runInBackground ? "background" : "foreground"}`,
    contextLine,
    "System prompt: subagent replacement prompt",
    "Runtime: parent working directory, active tools, and loaded extensions",
  ].join("\n");
}

/** Run an operation behind a bordered loader overlay (abortable). */
async function withLoader<T>(
  ctx: ExtensionContext,
  label: string,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<{ value?: T; error?: unknown; cancelled?: boolean } | undefined> {
  if (ctx.mode !== "tui") {
    try { return { value: await op(new AbortController().signal) }; }
    catch (error) { return { error }; }
  }
  return ctx.ui.custom<{ value?: T; error?: unknown; cancelled?: boolean }>((tui, theme, _kb, done) => {
    let settled = false;
    const finish = (v: { value?: T; error?: unknown; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      done(v);
    };
    const run = (signal: AbortSignal) => {
      op(signal).then((value) => finish({ value })).catch((error) => finish({ error }));
    };
    if (tui && theme) {
      const loader = new BorderedLoader(tui as never, theme as never, label);
      loader.onAbort = () => finish({ cancelled: true });
      run(loader.signal);
      return loader;
    }
    // Non-TUI stub surface (tests): run the op and resolve via done.
    run(new AbortController().signal);
    return { render: () => [label], invalidate: () => {}, handleInput: () => {} };
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function approveInvocation(
  ctx: ExtensionContext,
  registry: ModelRegistry,
  initial: ApprovalRequest,
  contextInput?: ApprovalContextInput,
): Promise<ApprovalResult> {
  if (ctx.mode !== "tui") return { outcome: "cancel" };

  const request = { ...initial };
  /**
   * Context built so far; survives loop iterations. For /ot-launched agents the
   * inherited chain is pre-seeded so launching without the builder still
   * carries the picked node's context.
   */
  let built: BuiltLedgerContext | undefined = contextInput?.presetInherited?.length
    ? { selectedIds: [], summary: undefined, inheritedNodes: contextInput.presetInherited }
    : undefined;

  for (;;) {
    const actions = [
      "Review / edit task prompt",
      ...(contextInput ? ["Build context ledger"] : []),
      "Launch",
      `Change model (${modelId(request.model)})`,
      `Change reasoning (${request.thinking})`,
      "Feedback to main agent",
      "Do it yourself",
    ];
    actions.push("Cancel");

    const action = await ctx.ui.select(
      buildSummary(request, built, (contextInput?.candidates.length ?? 0) > 0),
      actions,
    );
    if (!action || action === "Cancel") return { outcome: "cancel" };
    if (action === "Launch") {
      return { outcome: "launch", prompt: request.prompt, model: request.model, thinking: request.thinking, ...(built ? { context: built } : {}) };
    }
    if (action === "Review / edit task prompt") {
      const prompt = await ctx.ui.editor("Review subagent task prompt", request.prompt);
      if (prompt?.trim()) request.prompt = prompt;
      continue;
    }
    if (action === "Build context ledger") {
      const builtSelection = await buildContextUI({
        ctx,
        branch: contextInput!.branch,
      });
      if (!builtSelection) continue; // cancelled / nothing selected

      // Step 2: inherit prior ledger context? y/n — only asked when something
      // can actually be inherited (no dead UI); pre-answered Yes by an /ot
      // launch preset. Yes pulls up the /ot tree in select mode.
      let inheritedNodes: ContextLedgerNode[] = [];
      if (contextInput!.candidates.length > 0) {
        const wantInherit = contextInput!.presetInherited?.length
          ? true
          : (await ctx.ui.select(
              "Inherit prior ledger context?",
              ["Yes", "No"],
            )) === "Yes";
        if (wantInherit && contextInput!.openInheritTree) {
          const initial = contextInput!.presetInherited?.length
            ? contextInput!.presetInherited.map((n) => n.id)
            : [contextInput!.candidates[0]!.id]; // nearest ledger default
          const inherited = await contextInput!.openInheritTree(initial);
          if (inherited) inheritedNodes = inherited; // root→leaf; [] = none kept
        }
      }

      // Step 3: compact the FULL conversation? y/n.
      const compactChoice = await ctx.ui.select(
        "Compact the full conversation before sendoff?",
        ["Yes", "No"],
      );
      let summary: string | undefined;
      if (compactChoice === "Yes") {
        // Whole conversation message ids (tool results excluded — noise).
        const fullIds = contextInput!.branch
          .filter((e) => e.type === "message")
          .map((e) => e.id);
        const result = await withLoader(ctx, "Compacting full conversation…", (signal) =>
          contextInput!.summarize(contextInput!.branch, fullIds, request.model, request.thinking),
        );
        if (result?.cancelled) {
          ctx.ui.notify("Compaction cancelled — sending without a compacted summary.", "info");
        } else if (result?.error) {
          ctx.ui.notify(`Compaction failed: ${messageOf(result.error)}`, "error");
        } else if (typeof result?.value === "string") {
          summary = result.value;
        }
      }

      if (builtSelection.selectedIds.length === 0 && !summary && inheritedNodes.length === 0) continue;
      built = {
        selectedIds: builtSelection.selectedIds,
        summary,
        inheritedNodes,
      };
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
        if (built?.summary) {
          built.summary = undefined;
          ctx.ui.notify("Compact summary invalidated by the model change — regenerate it with c in the context builder.", "info");
        }
      }
      continue;
    }
    if (action.startsWith("Change reasoning")) {
      const selected = await ctx.ui.select("Select subagent reasoning level", availableThinkingLevels(request.model));
      if (selected) {
        request.thinking = selected as ThinkingLevel;
        if (built?.summary) {
          built.summary = undefined;
          ctx.ui.notify("Compact summary invalidated by the reasoning change — regenerate it with c in the context builder.", "info");
        }
      }
      continue;
    }
  }
}
