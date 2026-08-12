import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  Container,
  Input,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import { limitsForContextWindow } from "../fresh/limits.js";

export const DEFAULT_MODEL_PROVIDER = "openai-codex";
export const DEFAULT_MODEL_ID = "gpt-5.6-sol";
export const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

const THINKING_COLORS = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
} as const;

export interface ModelThinkingSelection {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

export function orderModels(models: Model<Api>[]): Model<Api>[] {
  return [...models].sort((a, b) => {
    const aDefault = a.provider === DEFAULT_MODEL_PROVIDER && a.id === DEFAULT_MODEL_ID;
    const bDefault = b.provider === DEFAULT_MODEL_PROVIDER && b.id === DEFAULT_MODEL_ID;
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
}

export async function selectModelAndThinking(
  ctx: ExtensionContext,
  models: Model<Api>[],
  estimatedFileTokens: number,
  initial?: ModelThinkingSelection,
): Promise<ModelThinkingSelection | undefined> {
  if (models.length === 0) return undefined;

  return ctx.ui.custom<ModelThinkingSelection | undefined>((tui, theme, keybindings, done) => {
    const search = new Input();
    let filtered = models;
    let selectedIndex = initial
      ? Math.max(0, models.findIndex((model) => sameModel(model, initial.model)))
      : 0;
    let thinkingLevel = initial?.thinkingLevel ?? preferredThinkingLevel(filtered[selectedIndex]!);
    let validationMessage = "";

    const selectedModel = () => filtered[selectedIndex];
    const resetThinking = () => {
      const model = selectedModel();
      if (model) thinkingLevel = preferredThinkingLevel(model);
      validationMessage = "";
    };
    const updateFilter = () => {
      const query = search.getValue().trim().toLowerCase();
      filtered = query
        ? models.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
        : models;
      selectedIndex = 0;
      resetThinking();
    };
    const moveSelection = (delta: number) => {
      if (filtered.length === 0) return;
      selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
      resetThinking();
    };
    const cycleThinking = (delta: number) => {
      const model = selectedModel();
      if (!model) return;
      const levels = getSupportedThinkingLevels(model);
      const current = Math.max(0, levels.indexOf(thinkingLevel));
      thinkingLevel = levels[(current + delta + levels.length) % levels.length]!;
      validationMessage = "";
    };

    const component: Focusable & {
      render(width: number): string[];
      handleInput(data: string): void;
      invalidate(): void;
    } = {
      get focused() { return search.focused; },
      set focused(value: boolean) { search.focused = value; },
      render(width: number) {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Choose Fresh Session Model")), 1, 0));
        container.addChild(new Text(theme.fg("muted", "Search"), 1, 0));
        container.addChild(search);

        if (filtered.length === 0) {
          container.addChild(new Text(theme.fg("warning", "No matching models"), 1, 1));
        } else {
          const maxVisible = 10;
          const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
          const end = Math.min(start + maxVisible, filtered.length);
          for (let index = start; index < end; index++) {
            const model = filtered[index]!;
            const prefix = index === selectedIndex ? theme.fg("accent", "→ ") : "  ";
            const label = `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
            container.addChild(new Text(prefix + (index === selectedIndex ? theme.fg("accent", label) : label), 1, 0));
          }
          if (filtered.length > maxVisible) {
            container.addChild(new Text(theme.fg("dim", `${selectedIndex + 1}/${filtered.length}`), 3, 0));
          }

          const model = selectedModel()!;
          const transferLimit = limitsForContextWindow(model.contextWindow).maxTransferTokens;
          const fits = estimatedFileTokens <= transferLimit;
          container.addChild(new Text("", 0, 0));
          container.addChild(new Text(
            `${theme.fg("muted", "Thinking: ")}${theme.fg(THINKING_COLORS[thinkingLevel], thinkingLevel)}`,
            1,
            0,
          ));
          container.addChild(new Text(
            theme.fg(fits ? "muted" : "error", `File context: est. ${formatTokens(estimatedFileTokens)} tokens · 80% limit: ${formatTokens(transferLimit)}`),
            1,
            0,
          ));
        }

        if (validationMessage) container.addChild(new Text(theme.fg("error", validationMessage), 1, 0));
        container.addChild(new Text(theme.fg("dim", "↑↓ model • type to search • tab/shift+tab thinking • enter select • esc back"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return container.render(width).map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) moveSelection(-1);
        else if (keybindings.matches(data, "tui.select.down")) moveSelection(1);
        else if (matchesKey(data, Key.shift("tab"))) cycleThinking(-1);
        else if (keybindings.matches(data, "tui.input.tab")) cycleThinking(1);
        else if (keybindings.matches(data, "tui.select.confirm")) {
          const model = selectedModel();
          if (model) {
            const transferLimit = limitsForContextWindow(model.contextWindow).maxTransferTokens;
            if (estimatedFileTokens > transferLimit) {
              validationMessage = `File context exceeds this model's 80% context-window limit.`;
            } else {
              done({ model, thinkingLevel });
              return;
            }
          }
        } else {
          search.handleInput(data);
          updateFilter();
        }
        tui.requestRender();
      },
      invalidate() {
        search.invalidate();
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: { width: "72%", minWidth: 60, maxHeight: "85%", margin: 1 },
  });
}

function preferredThinkingLevel(model: Model<Api>): ModelThinkingLevel {
  return clampThinkingLevel(model, DEFAULT_THINKING_LEVEL);
}

function sameModel(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}
