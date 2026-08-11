import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { serializeFreshFiles } from "./context-message.js";
import type { ExcludedFile, FileExclusionReason, FreshLimits, PreparedContext, PreparedFile, ReadCandidate, ReadLedger } from "./types.js";

class FilePreparationError extends Error {
  constructor(public reason: FileExclusionReason, message: string) {
    super(message);
  }
}

export async function prepareSelectedFiles(
  selectedPaths: string[],
  ledger: ReadLedger,
  limits: FreshLimits,
): Promise<PreparedContext> {
  const byPath = new Map(ledger.candidates.map((candidate) => [candidate.path, candidate]));
  const included: PreparedFile[] = [];
  const excluded: ExcludedFile[] = [];

  for (const selectedPath of selectedPaths) {
    const candidate = byPath.get(selectedPath);
    if (!candidate) throw new Error(`Selected path is not in the ledger: ${selectedPath}`);
    try {
      included.push(await prepareFile(candidate, ledger.projectRoot, limits.maxFileBytes));
    } catch (error) {
      const failure = error instanceof FilePreparationError
        ? error
        : new FilePreparationError("unreadable", error instanceof Error ? error.message : String(error));
      excluded.push({ path: selectedPath, reason: failure.reason, detail: failure.message });
    }
  }

  const totalBytes = included.reduce((sum, file) => sum + file.bytes, 0);
  const estimatedTokens = estimateTokens(serializeFreshFiles(included));
  let blockedReason: string | undefined;
  if (included.length === 0) blockedReason = "No selected files can be transferred";
  else if (estimatedTokens > limits.maxTransferTokens) {
    blockedReason = `Estimated file context (${estimatedTokens} tokens) exceeds the ${limits.maxTransferTokens}-token limit`;
  }

  return { selectedPaths: [...selectedPaths], included, excluded, totalBytes, estimatedTokens, blockedReason };
}

export async function verifyPreparedFilesUnchanged(files: PreparedFile[], projectRoot: string): Promise<void> {
  for (const file of files) {
    let resolved: string;
    let buffer: Buffer;
    try {
      resolved = await realpath(file.absolutePath);
      if (!isInsideProject(resolved, await realpath(projectRoot))) throw new Error("resolved outside the project");
      buffer = await readFile(resolved);
    } catch (error) {
      throw new Error(`${file.path} is no longer available: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sha256(buffer) !== file.sha256) throw new Error(`${file.path} changed after it was reviewed`);
  }
}

export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

async function prepareFile(candidate: ReadCandidate, projectRoot: string, maxFileBytes: number): Promise<PreparedFile> {
  let realRoot: string;
  let resolved: string;
  try {
    [realRoot, resolved] = await Promise.all([realpath(projectRoot), realpath(candidate.absolutePath)]);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new FilePreparationError("missing", "File no longer exists");
    throw new FilePreparationError("unreadable", error instanceof Error ? error.message : String(error));
  }
  if (!isInsideProject(resolved, realRoot)) throw new FilePreparationError("outside-project", "Resolved path is outside the project");

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new FilePreparationError("unreadable", error instanceof Error ? error.message : String(error));
  }
  if (!info.isFile()) throw new FilePreparationError("not-file", "Path is not a regular file");
  if (info.size > maxFileBytes) throw new FilePreparationError("oversized", `File exceeds ${maxFileBytes} bytes`);

  let buffer: Buffer;
  try {
    buffer = await readFile(resolved);
  } catch (error) {
    throw new FilePreparationError("unreadable", error instanceof Error ? error.message : String(error));
  }
  if (buffer.byteLength > maxFileBytes) throw new FilePreparationError("oversized", `File exceeds ${maxFileBytes} bytes`);
  if (buffer.includes(0)) throw new FilePreparationError("unsupported", "Binary content is not supported");

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new FilePreparationError("unsupported", "Content is not valid UTF-8 text");
  }

  return {
    path: candidate.path,
    absolutePath: candidate.absolutePath,
    content,
    bytes: buffer.byteLength,
    estimatedTokens: estimateTokens(content),
    sha256: sha256(buffer),
  };
}

function isInsideProject(filePath: string, projectRoot: string): boolean {
  const relative = path.relative(projectRoot, filePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
