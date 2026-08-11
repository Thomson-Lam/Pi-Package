import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addReadEvent, captureSystemPrompt, resetVolatileState, updateReadEventResult } from "./state.js";
import { contentToText, previewText } from "./reconstruct.js";
import { refreshWidget } from "./ui/widget.js";

export function registerCollectors(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    resetVolatileState();
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setWidget("ctx", undefined);
      ctx.ui.setStatus("ctx", undefined);
    } catch {
      // no-op outside interactive UI
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    captureSystemPrompt((event as any).systemPrompt, (event as any).systemPromptOptions);
    refreshWidget(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if ((event as any).toolName !== "read") return;
    const input = (event as any).input ?? {};
    const rawPath = String(input.path ?? "");
    addReadEvent({
      id: `read-${(event as any).toolCallId ?? Date.now()}`,
      path: rawPath,
      offset: typeof input.offset === "number" ? input.offset : undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
      toolCallId: (event as any).toolCallId,
    });
    refreshWidget(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if ((event as any).toolName !== "read") return;
    const text = contentToText((event as any).content);
    updateReadEventResult((event as any).toolCallId, previewText(text, 240), text.length, (event as any).isError, text);
    refreshWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => refreshWidget(ctx));
  pi.on("session_compact", async (_event, ctx) => refreshWidget(ctx));
  pi.on("session_tree", async (_event, ctx) => refreshWidget(ctx));
}
