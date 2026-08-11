import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { normalizeReadPath } from "./ledger.js";
import type { ReadCandidate, ReadLedger } from "./types.js";

export class SelectionValidationError extends Error {}

export interface SelectionResult {
  selectedPaths: string[];
  ledger: ReadLedger;
  suggestedPaths: string[];
}

let pendingAssistantResponse: ((text: string) => void) | undefined;

export function observeFreshSelectionMessage(event: MessageEndEvent): void {
  if (!pendingAssistantResponse || event.message.role !== "assistant") return;
  const text = event.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text ?? "")
    .join("\n");
  const resolve = pendingAssistantResponse;
  pendingAssistantResponse = undefined;
  resolve(text);
}

export async function selectRelevantPaths(
  pi: ExtensionAPI,
  ledger: ReadLedger,
  maxSelectedFiles: number,
): Promise<SelectionResult> {
  const responsePromise = waitForNextAssistantResponse();
  pi.sendUserMessage(buildSelectionRequest(ledger, maxSelectedFiles));
  const response = await responsePromise;
  if (!response) throw new SelectionValidationError("Agent did not respond with a fresh-context selection");
  return parseSelectionResponse(response, ledger, maxSelectedFiles);
}

export function buildSelectionRequest(ledger: ReadLedger, maxSelectedFiles = 24): string {
  return [
    "Fresh-context file selection request.",
    "Select files for continuing the current focused work.",
    "Use the previously-read ledger as the primary list. If an important project file is missing, include it under suggestedPaths.",
    "Do not summarize or plan. Reply only with this exact block format:",
    "",
    "<fresh-context-selection>",
    "paths:",
    "- path/from/ledger.ts",
    "suggestedPaths:",
    "- relevant/project/path-not-in-ledger.ts",
    "</fresh-context-selection>",
    "",
    `Select at least one and no more than ${maxSelectedFiles} total files.`,
    "",
    "## Previously read files",
    "",
    formatLedgerMarkdown(ledger),
  ].join("\n");
}

export function formatLedgerMarkdown(ledger: ReadLedger): string {
  return ledger.candidates.map((candidate) => `- \`${candidate.path}\``).join("\n") || "- (none)";
}

export function parseSelectionResponse(
  response: string,
  ledger: ReadLedger,
  maxSelectedFiles: number,
): SelectionResult {
  const match = response.match(/<fresh-context-selection>\s*([\s\S]*?)\s*<\/fresh-context-selection>/i);
  if (!match) throw new SelectionValidationError("Agent response did not contain a fresh-context selection block");

  const paths: string[] = [];
  const suggestedPaths: string[] = [];
  let section: "paths" | "suggestedPaths" | undefined;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^paths:\s*$/i.test(line)) {
      section = "paths";
      continue;
    }
    if (/^suggestedPaths:\s*$/i.test(line)) {
      section = "suggestedPaths";
      continue;
    }
    const item = line.match(/^-\s+`?([^`]+?)`?\s*$/)?.[1]?.trim();
    if (!item || !section) throw new SelectionValidationError(`Malformed selection line: ${rawLine}`);
    if (section === "paths") paths.push(item);
    else suggestedPaths.push(item);
  }

  return validateSelection({ paths, suggestedPaths }, ledger, maxSelectedFiles);
}

export function validateSelection(
  value: { paths: string[]; suggestedPaths?: string[] },
  ledger: ReadLedger,
  maxSelectedFiles: number,
): SelectionResult {
  const keys = Object.keys(value).sort();
  const allowedKeys = value.suggestedPaths === undefined ? ["paths"] : ["paths", "suggestedPaths"];
  if (keys.length !== allowedKeys.length || !allowedKeys.every((key, index) => keys[index] === key)) {
    throw new SelectionValidationError("Agent selection contained unexpected properties");
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) throw new SelectionValidationError("Agent selected no files");
  if (value.suggestedPaths !== undefined && !Array.isArray(value.suggestedPaths)) throw new SelectionValidationError("Agent suggested paths must be an array");

  const candidatePaths = new Set(ledger.candidates.map((candidate) => candidate.path));
  const selectedPaths: string[] = [];
  const seen = new Set<string>();

  for (const selectedPath of value.paths) {
    if (typeof selectedPath !== "string" || !selectedPath) throw new SelectionValidationError("Agent selection contained an invalid path");
    if (seen.has(selectedPath)) throw new SelectionValidationError(`Agent selected a duplicate path: ${selectedPath}`);
    if (!candidatePaths.has(selectedPath)) throw new SelectionValidationError(`Agent selected a path outside the ledger: ${selectedPath}`);
    seen.add(selectedPath);
    selectedPaths.push(selectedPath);
  }

  const suggestedCandidates: ReadCandidate[] = [];
  for (const suggestedPath of value.suggestedPaths ?? []) {
    if (typeof suggestedPath !== "string" || !suggestedPath.trim()) throw new SelectionValidationError("Agent suggested an invalid path");
    const candidate = normalizeReadPath(suggestedPath, ledger.projectRoot);
    if (!candidate) throw new SelectionValidationError(`Agent suggested a path outside the project: ${suggestedPath}`);
    if (seen.has(candidate.path)) throw new SelectionValidationError(`Agent selected a duplicate path: ${candidate.path}`);
    seen.add(candidate.path);
    selectedPaths.push(candidate.path);
    suggestedCandidates.push(candidate);
  }

  if (selectedPaths.length > maxSelectedFiles) throw new SelectionValidationError(`Agent selected more than ${maxSelectedFiles} files`);

  return {
    selectedPaths,
    ledger: {
      ...ledger,
      candidates: [...ledger.candidates, ...suggestedCandidates],
    },
    suggestedPaths: suggestedCandidates.map((candidate) => candidate.path),
  };
}

function waitForNextAssistantResponse(): Promise<string> {
  return new Promise((resolve) => {
    pendingAssistantResponse = resolve;
  });
}
