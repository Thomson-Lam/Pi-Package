import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { AnchorItem } from "../anchors.js";

function formatLocalTimestamp(timestamp: string): string {
  const time = new Date(timestamp);
  if (Number.isNaN(time.getTime())) return timestamp;
  return time.toLocaleString();
}

function toSelectItem(anchor: AnchorItem): SelectItem {
  const role = anchor.role === "assistant" ? "A" : anchor.role === "user" ? "U" : " ";
  return { value: anchor.id, label: anchor.label, description: `${role}  ${formatLocalTimestamp(anchor.timestamp)}` };
}

export async function openAnchorList(ctx: ExtensionCommandContext, anchors: AnchorItem[]): Promise<AnchorItem | undefined> {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const items = anchors.map(toSelectItem);

  const selectedId = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Labels")), 1, 0));

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
    container.addChild(new Text(theme.fg("dim", "↑↓/j/k navigate • enter jump • esc cancel"), 1, 0));
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

  return selectedId ? byId.get(selectedId) : undefined;
}
