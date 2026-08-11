import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReadCandidate, ReadLedger } from "./types.js";

interface ReadCall {
  toolCallId: string;
  path: string;
}

export function buildReadLedger(branch: SessionEntry[], cwd: string): ReadLedger {
  const successfulResults = collectSuccessfulReadResults(branch);
  const candidates = new Map<string, ReadCandidate>();

  for (const call of collectReadCalls(branch)) {
    if (!successfulResults.has(call.toolCallId)) continue;
    const candidate = normalizeReadPath(call.path, cwd);
    if (candidate && !candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
  }

  return {
    version: 1,
    projectRoot: path.resolve(cwd),
    candidates: [...candidates.values()],
  };
}

export function collectReadCalls(branch: SessionEntry[]): ReadCall[] {
  const calls: ReadCall[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall" || block.name !== "read") continue;
      const rawPath = (block.arguments as { path?: unknown } | undefined)?.path;
      if (typeof rawPath === "string" && rawPath.trim()) calls.push({ toolCallId: block.id, path: rawPath });
    }
  }
  return calls;
}

export function collectSuccessfulReadResults(branch: SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName === "read" && !entry.message.isError) ids.add(entry.message.toolCallId);
  }
  return ids;
}

export function normalizeReadPath(rawPath: string, cwd: string): ReadCandidate | undefined {
  const projectRoot = path.resolve(cwd);
  const trimmed = rawPath.trim();
  const cleaned = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!cleaned) return undefined;
  const absolutePath = path.resolve(projectRoot, cleaned);
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return { path: relative.split(path.sep).join("/"), absolutePath };
}
