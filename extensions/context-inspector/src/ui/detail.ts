import type { ContextItem } from "../types.js";

export function buildDetailText(item: ContextItem, _cwd: string): string {
  const lines: string[] = [];
  lines.push(item.title);
  lines.push("".padEnd(Math.min(72, Math.max(12, item.title.length)), "─"));
  lines.push(`Type: ${item.type}`);
  lines.push(`Status: ${item.status}`);
  lines.push(`Source: ${item.sourceLabel}`);
  if (item.path) lines.push(`Path: ${item.path}`);
  lines.push(`Why included: ${item.includedReason}`);

  if (item.metadata && Object.keys(item.metadata).length > 0) {
    lines.push("", "Metadata:", JSON.stringify(item.metadata, null, 2));
  }

  lines.push("", item.type === "readFile" ? "Snapshot captured at read time:" : "Content snapshot:");
  lines.push(item.contentText || item.preview || "(no text content captured)");
  return lines.join("\n");
}
