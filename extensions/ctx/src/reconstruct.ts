import path from "node:path";
import type { ContextCounts, ContextItem, ContextItemStatus, InspectorState } from "./types.js";

export function buildContextItems(ctx: any, state: InspectorState): ContextItem[] {
  const items: ContextItem[] = [];
  const cwd = String(ctx?.cwd ?? "");
  let order = 0;
  const add = (item: Omit<ContextItem, "order">) => items.push({ ...item, order: order++ });

  // Files Pi injected before the turn (AGENTS.md / configured context files).
  for (const [i, file] of (state.lastSystemPromptOptions?.contextFiles ?? []).entries()) {
    const displayPath = pathForDisplay(file.path, cwd);
    add({
      id: `context-file-${i}-${file.path}`,
      type: "contextFile",
      title: displayPath,
      sourceLabel: "startup context file",
      path: displayPath,
      status: "system",
      includedReason: "Loaded by Pi as a context file before the agent turn.",
      preview: previewText(file.content || file.path),
      contentText: file.content,
    });
  }

  const branch = safeGetBranch(ctx);
  const latestCompactionIndex = findLatestCompactionIndex(branch);
  const summarizedReadFiles = collectSummarizedReadFiles(branch);
  const toolCallArgs = collectToolCallArgs(branch);

  for (const [idx, entry] of branch.entries()) {
    const entryStatus: ContextItemStatus = idx > latestCompactionIndex ? "active" : "historical";
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "read") {
      const msg = entry.message;
      const text = contentToText(msg.content);
      const args = toolCallArgs.get(msg.toolCallId) ?? {};
      const rawReadPath = extractReadPath(msg, args) ?? "unknown file";
      const readPath = pathForDisplay(rawReadPath, cwd);
      add({
        id: `read-file-${entry.id}`,
        type: "readFile",
        title: `Read: ${readPath}`,
        sourceLabel: "read tool snapshot",
        path: readPath,
        status: summarizedReadFiles.has(readPath) ? "summarized" : entryStatus,
        includedReason: "Exact read tool result stored in the session. This is the snapshot the agent saw at read time.",
        preview: previewText(text),
        contentText: text,
        metadata: {
          toolCallId: msg.toolCallId,
          timestamp: msg.timestamp ?? entry.timestamp,
          parentEntryId: entry.id,
          offset: typeof args.offset === "number" ? args.offset : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          args,
          details: msg.details,
          isError: msg.isError,
        },
      });
    } else if (entry?.type === "compaction") {
      add({
        id: `compaction-${entry.id}`,
        type: "compactionSummary",
        title: "Compaction summary",
        sourceLabel: "session compaction",
        status: "summarized",
        includedReason: "Pi compacted earlier history into this summary.",
        preview: previewText(entry.summary),
        contentText: detailForSummary(entry),
        metadata: { timestamp: entry.timestamp, details: entry.details },
      });
    } else if (entry?.type === "branch_summary") {
      add({
        id: `branch-summary-${entry.id}`,
        type: "branchSummary",
        title: "Branch summary",
        sourceLabel: "session branch summary",
        status: "summarized",
        includedReason: "Pi summarized context from a branch switch.",
        preview: previewText(entry.summary),
        contentText: detailForSummary(entry),
        metadata: { timestamp: entry.timestamp, parentEntryId: entry.parentId, details: entry.details },
      });
    }
  }

  // Include in-flight/current-runtime reads that may not have been appended to the session yet.
  for (const ev of state.readEvents) {
    if (items.some((i) => i.type === "readFile" && i.metadata?.toolCallId === ev.toolCallId)) continue;
    add({
      id: `tracked-read-${ev.id}`,
      type: "readFile",
      title: `Read: ${pathForDisplay(ev.path, cwd)}`,
      sourceLabel: ev.resultContent ? "read tool snapshot" : "read tool call",
      path: pathForDisplay(ev.path, cwd),
      status: "likely-active",
      includedReason: ev.resultContent
        ? "Captured by Ctx during this runtime from the read tool result."
        : "Observed by Ctx's tool_call hook; result snapshot has not arrived yet.",
      preview: previewText(ev.resultPreview || `${ev.path}${ev.offset ? ` offset ${ev.offset}` : ""}${ev.limit ? ` limit ${ev.limit}` : ""}`),
      contentText: ev.resultContent,
      metadata: { toolCallId: ev.toolCallId, timestamp: ev.timestamp, offset: ev.offset, limit: ev.limit, isError: ev.isError },
    });
  }

  return items.map((item, order) => ({ ...item, order }));
}

export function summarizeCounts(items: ContextItem[]): ContextCounts {
  const counts: ContextCounts = {
    total: items.length,
    systemPrompt: 0,
    contextFile: 0,
    skill: 0,
    readFile: 0,
    userMessage: 0,
    assistantMessage: 0,
    toolCall: 0,
    toolResult: 0,
    compactionSummary: 0,
    branchSummary: 0,
    customMessage: 0,
    active: 0,
    system: 0,
    summarized: 0,
    historical: 0,
    likelyActive: 0,
  };
  for (const item of items) {
    (counts as any)[item.type] = ((counts as any)[item.type] ?? 0) + 1;
    if (item.status === "likely-active") counts.likelyActive++;
    else (counts as any)[item.status] = ((counts as any)[item.status] ?? 0) + 1;
  }
  return counts;
}

export function uniqueReadFileCount(items: ContextItem[]): number {
  return new Set(items.filter((i) => i.type === "readFile" && i.path).map((i) => i.path)).size;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => {
    if (b?.type === "text") return b.text ?? "";
    if (b?.type === "thinking") return `[thinking]\n${b.thinking ?? ""}`;
    if (b?.type === "image") return `[image ${b.mimeType ?? b.mediaType ?? ""}]`;
    if (b?.type === "toolCall") return `[toolCall ${b.name ?? "tool"} ${b.id ?? ""}] ${JSON.stringify(b.arguments ?? {})}`;
    return JSON.stringify(b);
  }).filter(Boolean).join("\n");
}

export function previewText(text: unknown, max = 120): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function safeGetBranch(ctx: any): any[] {
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function findLatestCompactionIndex(branch: any[]): number {
  let latest = -1;
  branch.forEach((entry, i) => {
    if (entry?.type === "compaction") latest = i;
  });
  return latest;
}

function collectToolCallArgs(branch: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const entry of branch) {
    const msg = entry?.type === "message" ? entry.message : undefined;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.id) map.set(block.id, block.arguments ?? {});
    }
  }
  return map;
}

function collectSummarizedReadFiles(branch: any[]): Set<string> {
  const set = new Set<string>();
  for (const entry of branch) {
    const files = entry?.details?.readFiles;
    if (Array.isArray(files)) files.forEach((f) => set.add(String(f)));
  }
  return set;
}

function extractReadPath(msg: any, args?: any): string | undefined {
  const d = msg?.details;
  return args?.path ?? d?.path ?? d?.filePath ?? d?.input?.path ?? d?.args?.path;
}

function detailForSummary(entry: any): string {
  const lines = [entry.summary ?? ""];
  if (entry.details) lines.push("", "Details:", JSON.stringify(entry.details, null, 2));
  return lines.join("\n");
}

function pathForDisplay(filePath: string, cwd: string): string {
  if (!filePath) return "unknown file";
  if (!cwd || !path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(cwd, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return rel;
}
