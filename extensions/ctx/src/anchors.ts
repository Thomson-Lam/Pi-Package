import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openAnchorList } from "./ui/anchor-list.js";

export type AnchorTargetRole = "assistant" | "user";

type MessageEntry = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: { role: string; content?: unknown };
};

type AnyEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string; content?: unknown };
};

export interface AnchorItem {
  id: string;
  label: string;
  timestamp: string;
  preview: string;
  role?: "assistant" | "user";
}

export type LabelValidation = { ok: true; label: string } | { ok: false; message: string };

const MAX_LABEL_LENGTH = 80;

export function messagePreview(entry: MessageEntry): string {
  const content = entry.message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join(" ")
      : "";
  return text.trim().replace(/\s+/g, " ").slice(0, 100);
}

export function findLatestMessageEntry(entries: AnyEntry[], role: AnchorTargetRole): MessageEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === role) return entry as MessageEntry;
  }
  return undefined;
}

export function collectAnchors(sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getEntries" | "getLabel">): AnchorItem[] {
  return sessionManager.getEntries()
    .map((entry) => {
      const label = sessionManager.getLabel(entry.id);
      if (!label) return undefined;
      return {
        id: entry.id,
        label,
        timestamp: entry.timestamp,
        preview: entry.type === "message" ? messagePreview(entry) : entry.type,
        role: entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "user") ? entry.message.role : undefined,
      } satisfies AnchorItem;
    })
    .filter((item): item is AnchorItem => item !== undefined);
}

export function validateLabel(labelInput: string, existingLabels: Iterable<string>): LabelValidation {
  const label = labelInput.trim();
  if (!label) return { ok: false, message: "Label is required." };
  if (label.length > MAX_LABEL_LENGTH) return { ok: false, message: `Label must be ${MAX_LABEL_LENGTH} characters or fewer.` };
  if (/\r|\n/.test(label)) return { ok: false, message: "Label must be one line." };
  for (const existing of existingLabels) {
    if (existing === label) return { ok: false, message: `Label already exists: ${label}` };
  }
  return { ok: true, label };
}

function existingLabels(ctx: ExtensionCommandContext): string[] {
  return collectAnchors(ctx.sessionManager).map((anchor) => anchor.label);
}

async function getLabelFromArgsOrInput(ctx: ExtensionCommandContext, args: string, title: string): Promise<string | undefined> {
  const inline = args.trim();
  if (inline) return inline;
  return ctx.ui.input(title, "label");
}

export async function labelLatestMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string, role: AnchorTargetRole): Promise<void> {
  const roleName = role === "assistant" ? "agent" : "user";
  const input = await getLabelFromArgsOrInput(ctx, args, `Label latest ${roleName} message`);
  if (input === undefined) return;

  const validation = validateLabel(input, existingLabels(ctx));
  if (!validation.ok) {
    ctx.ui.notify(validation.message, "error");
    return;
  }

  const target = findLatestMessageEntry(ctx.sessionManager.getBranch(), role);
  if (!target) {
    ctx.ui.notify(`No ${roleName} message found on the active branch.`, "warning");
    return;
  }

  pi.setLabel(target.id, validation.label);
  ctx.ui.notify(`Labeled latest ${roleName} message: ${validation.label}`, "info");
}

export async function jumpToAnchor(ctx: ExtensionCommandContext): Promise<void> {
  const anchors = collectAnchors(ctx.sessionManager);
  if (anchors.length === 0) {
    ctx.ui.notify("No labels found in this session.", "warning");
    return;
  }

  const selected = await openAnchorList(ctx, anchors);
  if (!selected) return;

  await ctx.navigateTree(selected.id, { summarize: false });
}
