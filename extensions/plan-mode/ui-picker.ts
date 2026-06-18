import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface VimPickerOptions {
  searchable?: boolean;
  emptyMessage?: string;
  backValue?: string;
}

function filterItems(items: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.toLowerCase().includes(q));
}

export async function pickItemWithVimNav(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[],
  options: VimPickerOptions = {},
): Promise<string | undefined> {
  if (items.length === 0) return undefined;
  if (!ctx.hasUI) return ctx.ui.select(title, items);

  const searchable = options.searchable ?? true;

  return ctx.ui.custom((tui, theme, _kb, done) => {
    let activeIndex = 0;
    let mode: "browse" | "search" = "browse";
    let query = "";

    const getVisible = () => filterItems(items, query);

    const clampIndex = () => {
      const visible = getVisible();
      if (visible.length === 0) {
        activeIndex = 0;
      } else if (activeIndex >= visible.length) {
        activeIndex = visible.length - 1;
      }
    };

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        const visible = getVisible();
        clampIndex();

        lines.push(truncateToWidth(theme.fg("accent", theme.bold(title)), width));
        lines.push("");

        const controlsLine = searchable
          ? mode === "search"
            ? theme.fg("warning", `search> ${query}`)
            : theme.fg(
                "muted",
                options.backValue
                  ? "s:search  j/k:move  l/enter:select  h/esc:cancel  H:back"
                  : "s:search  j/k:move  l/enter:select  h/esc:cancel",
              )
          : theme.fg(
              "muted",
              options.backValue
                ? "j/k:move  l/enter:select  h/esc:cancel  H:back"
                : "j/k:move  l/enter:select  h/esc:cancel",
            );
        lines.push(truncateToWidth(controlsLine, width));
        lines.push("");

        if (visible.length === 0) {
          lines.push(truncateToWidth(theme.fg("muted", options.emptyMessage ?? "No results"), width));
          return lines;
        }

        for (let i = 0; i < visible.length; i++) {
          const item = visible[i];
          const isActive = i === activeIndex;
          const prefix = isActive ? theme.fg("accent", "❯ ") : "  ";
          const text = isActive ? theme.bold(item) : item;
          lines.push(truncateToWidth(`${prefix}${text}`, width));
        }

        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const visible = getVisible();

        if (mode === "search") {
          if (matchesKey(data, "escape") || data === "h") {
            mode = "browse";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "backspace")) {
            query = query.slice(0, -1);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "l") {
            if (visible.length > 0) done(visible[activeIndex]);
            return;
          }
          if (data.length === 1 && data >= " " && data !== "\u007f") {
            query += data;
            activeIndex = 0;
            tui.requestRender();
          }
          return;
        }

        if (options.backValue && data === "H") {
          done(options.backValue);
          return;
        }
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "h") {
          done(undefined);
          return;
        }
        if (matchesKey(data, "down") || data === "j") {
          if (visible.length > 0) activeIndex = (activeIndex + 1) % visible.length;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "up") || data === "k") {
          if (visible.length > 0) activeIndex = (activeIndex - 1 + visible.length) % visible.length;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "l") {
          if (visible.length > 0) done(visible[activeIndex]);
          return;
        }
        if (searchable && data === "s") {
          mode = "search";
          query = "";
          activeIndex = 0;
          tui.requestRender();
        }
      },
    };
  });
}

export async function pickListAction(
  ctx: ExtensionCommandContext,
  title: string,
  actions: string[],
): Promise<string | undefined> {
  return pickItemWithVimNav(ctx, title, actions, { searchable: false, backValue: "Back" });
}
