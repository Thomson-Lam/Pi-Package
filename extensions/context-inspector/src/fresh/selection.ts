import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReadLedger, SelectionEnvelope } from "./types.js";

const SELECTION_SYSTEM_PROMPT = `You select source files for a fresh continuation session.
Use the active conversation only to identify the current focused work.
Select only paths present in the supplied candidate ledger.
Return exactly one JSON object with this shape: {"version":1,"paths":["path/to/file"]}
Do not use Markdown fences. Do not explain, summarize, plan, rank, or add properties.
Return at least one path and do not return duplicate paths.`;

export class SelectionValidationError extends Error {}

export async function selectRelevantPaths(
  ctx: ExtensionCommandContext,
  ledger: ReadLedger,
  maxSelectedFiles: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!ctx.model) throw new Error("No model selected");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);

  const conversation = serializeConversation(convertToLlm(ctx.sessionManager.buildSessionContext().messages));
  const response = await complete(
    ctx.model,
    { systemPrompt: SELECTION_SYSTEM_PROMPT, messages: [buildSelectionRequest(ledger, conversation)] },
    { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
  );
  if (response.stopReason === "aborted") throw new DOMException("Selection cancelled", "AbortError");

  return parseSelectionOutput(extractAssistantText(response), new Set(ledger.candidates.map((candidate) => candidate.path)), maxSelectedFiles).paths;
}

export function buildSelectionRequest(ledger: ReadLedger, conversation = ""): Message {
  const machineLedger = {
    version: ledger.version,
    paths: ledger.candidates.map((candidate) => candidate.path),
  };
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        conversation ? `## Active conversation\n\n${conversation}` : "",
        `## Candidate read ledger\n\n${JSON.stringify(machineLedger)}`,
        "Select the relevant continuation files now.",
      ].filter(Boolean).join("\n\n"),
    }],
    timestamp: Date.now(),
  };
}

export function parseSelectionOutput(
  output: string,
  candidatePaths: Set<string>,
  maxSelectedFiles: number,
): SelectionEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new SelectionValidationError("Agent selection was not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SelectionValidationError("Agent selection must be an object");

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "paths" || keys[1] !== "version") {
    throw new SelectionValidationError("Agent selection contained unexpected properties");
  }
  if (record.version !== 1) throw new SelectionValidationError("Agent selection used an unsupported version");
  if (!Array.isArray(record.paths) || record.paths.length === 0) throw new SelectionValidationError("Agent selected no files");
  if (record.paths.length > maxSelectedFiles) throw new SelectionValidationError(`Agent selected more than ${maxSelectedFiles} files`);

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of record.paths) {
    if (typeof path !== "string" || !path) throw new SelectionValidationError("Agent selection contained an invalid path");
    if (seen.has(path)) throw new SelectionValidationError(`Agent selected a duplicate path: ${path}`);
    if (!candidatePaths.has(path)) throw new SelectionValidationError(`Agent selected a path outside the ledger: ${path}`);
    seen.add(path);
    paths.push(path);
  }
  return { version: 1, paths };
}

function extractAssistantText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}
