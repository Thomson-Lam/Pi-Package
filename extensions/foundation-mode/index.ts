import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const foundationPrompt = readFileSync(join(extensionDir, "foundation-prompt.md"), "utf8");

export default function foundationModeExtension(pi: ExtensionAPI): void {
  let foundationMode = false;

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

      foundationMode = action === "on" || (action === "" && !foundationMode);
      updateStatus(ctx);
      ctx.ui.notify(`Foundation Mode ${foundationMode ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));

  pi.on("before_agent_start", (event) => {
    if (!foundationMode) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${foundationPrompt}` };
  });
}
