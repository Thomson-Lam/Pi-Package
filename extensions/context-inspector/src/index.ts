import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { registerCollectors } from "./collector.js";
import { openContextPanel } from "./ui/panel.js";
import { openContextUsagePanel } from "./ui/context-usage-panel.js";
import { FRESH_CONTEXT_MESSAGE_TYPE } from "./fresh/context-message.js";
import { runFreshContextSession } from "./fresh/transition.js";
import { renderFreshContextMessage } from "./ui/fresh-message.js";

type CtxAction = "inspect" | "reads" | "help";
type ParsedCtx = { kind: "menu" } | { kind: "action"; action: CtxAction } | { kind: "error"; message: string };

const HELP_TEXT = `# /ctx

Open a UI-only context inspector. This help is rendered in a modal and is not injected into the current agent session.

## Actions

- Inspect / UI — show a rough Claude-Code-style context usage overview using Pi's available context usage APIs.
- Reads — inspect files and read-tool snapshots that are likely in session context.
- Help — show this help modal.

## Fresh sessions

- /cnew — select relevant files read on the active branch, review their current contents and size, then start a fresh session with a user-authored objective.

## Related commands

- /ctx — open the context menu
- /ctx inspect — open the usage overview directly
- /ctx reads — open read snapshots directly
- /reads — shortcut for read snapshots

## Notes

Pi exposes reliable total context usage via ctx.getContextUsage(). Bucket-level counts in the usage UI are intentionally rough estimates based on session entries, system prompt snapshots, context files, and read snapshots.`;

function parseCtxAction(args: string): ParsedCtx {
  const normalized = args.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return { kind: "menu" };
  if (normalized === "help" || normalized === "h") return { kind: "action", action: "help" };
  if (normalized === "reads" || normalized === "read") return { kind: "action", action: "reads" };
  if (normalized === "inspect" || normalized === "ui" || normalized === "usage" || normalized === "overview") return { kind: "action", action: "inspect" };
  return { kind: "error", message: "Usage: /ctx [inspect|reads|help]" };
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
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "j" || data === "J") selectList.handleInput("\x1b[B");
        else if (data === "k" || data === "K") selectList.handleInput("\x1b[A");
        else selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return result;
}

async function pickCtxAction(ctx: ExtensionCommandContext): Promise<CtxAction | undefined> {
  const selected = await selectModal(ctx, "Context Inspector", [
    { value: "inspect", label: "Inspect", description: "Open context usage overview" },
    { value: "reads", label: "Reads", description: "Inspect read-tool snapshots and context files" },
    { value: "help", label: "Help", description: "Show UI-only context inspector help" },
  ]);
  return selected as CtxAction | undefined;
}

async function showCtxHelp(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Context Inspector Help")), 1, 0));
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

async function runCtxAction(ctx: ExtensionCommandContext, action: CtxAction): Promise<void> {
  if (action === "help") return showCtxHelp(ctx);
  if (action === "reads") return openContextPanel(ctx as any);
  return openContextUsagePanel(ctx as any);
}

export default function (pi: ExtensionAPI) {
  registerCollectors(pi);
  pi.registerMessageRenderer(FRESH_CONTEXT_MESSAGE_TYPE, renderFreshContextMessage);

  pi.registerCommand("ctx", {
    description: "Open context inspector menu",
    getArgumentCompletions: (prefix) => {
      const items = ["inspect", "reads", "help"];
      return items.filter((item) => item.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const parsed = parseCtxAction(args || "");
      if (parsed.kind === "error") {
        ctx.ui.notify(parsed.message, "error");
        return;
      }
      const action = parsed.kind === "menu" ? await pickCtxAction(ctx) : parsed.action;
      if (!action) return;
      await runCtxAction(ctx, action);
    },
  });

  pi.registerCommand("cnew", {
    description: "Start a fresh session with relevant files already in context",
    handler: async (args, ctx) => {
      await runFreshContextSession(ctx, args || "");
    },
  });

  pi.registerCommand("reads", {
    description: "Open read snapshot inspector",
    handler: async (_args, ctx) => {
      await openContextPanel(ctx);
    },
  });

}
