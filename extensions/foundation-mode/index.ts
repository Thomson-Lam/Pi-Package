import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const foundationPrompt = readFileSync(join(extensionDir, "foundation-prompt.md"), "utf8");
const FOUNDATION_STATE_ENTRY_TYPE = "foundation-mode-state";

export default function foundationModeExtension(pi: ExtensionAPI): void {
  let foundationMode = false;

  const persistState = () => {
    pi.appendEntry(FOUNDATION_STATE_ENTRY_TYPE, {
      enabled: foundationMode,
      updatedAt: Date.now(),
    });
  };

  const restoreState = (ctx: ExtensionContext) => {
    foundationMode = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== FOUNDATION_STATE_ENTRY_TYPE) continue;
      const data = entry.data as { enabled?: boolean } | undefined;
      if (typeof data?.enabled === "boolean") foundationMode = data.enabled;
    }
  };

  const updateStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      "foundation-mode",
      foundationMode ? ctx.ui.theme.fg("accent", "foundation: on") : undefined,
    );
  };

  pi.registerCommand("foundation-mode", {
    description: "Toggle Foundation Mode",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "status") {
        ctx.ui.notify(`Foundation Mode is ${foundationMode ? "on" : "off"}.`, "info");
        return;
      }

      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /foundation-mode [on|off|status]", "error");
        return;
      }

      const nextMode = action === "on" || (action === "" && !foundationMode);
      if (nextMode === foundationMode) {
        ctx.ui.notify(`Foundation Mode is already ${foundationMode ? "on" : "off"}.`, "info");
        return;
      }

      foundationMode = nextMode;
      persistState();
      updateStatus(ctx);
      ctx.ui.notify(`Foundation Mode ${foundationMode ? "enabled" : "disabled"}. Reloading…`, "info");
      await ctx.reload();
      return;
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "reload") restoreState(ctx);
    else {
      foundationMode = false;
      persistState();
    }
    updateStatus(ctx);
  });

  pi.on("resources_discover", () =>
    foundationMode ? { skillPaths: [join(extensionDir, "skills")] } : {},
  );

  pi.on("before_agent_start", (event) => {
    if (!foundationMode) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${foundationPrompt}` };
  });
}
