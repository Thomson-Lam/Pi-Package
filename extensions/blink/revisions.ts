import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export interface FileIdentity {
  absolutePath: string;
  canonicalPath?: string;
  device?: number;
  inode?: number;
}

export interface FileRevision {
  kind: "file";
  bytes: Buffer;
  hash: string;
  mode: number;
  canonicalPath?: string;
  device?: number;
  inode?: number;
}

export interface AbsentRevision {
  kind: "absent";
}

export type PathRevision = FileRevision | AbsentRevision;

export interface Snapshot {
  path: string;
  byteLength: number;
  hash: string;
}

export class UnsupportedRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRevisionError";
  }
}

export class RevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function normalizeToolPath(input: string, cwd: string): string {
  const normalized = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, normalized);
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function filesystemKey(identity: Pick<FileIdentity, "device" | "inode">): string | undefined {
  return identity.device !== undefined && identity.inode !== undefined
    ? `${identity.device}:${identity.inode}`
    : undefined;
}

export function revisionIdentity(absolutePath: string, revision: PathRevision): FileIdentity {
  return revision.kind === "file"
    ? {
        absolutePath,
        canonicalPath: revision.canonicalPath,
        device: revision.device,
        inode: revision.inode,
      }
    : { absolutePath };
}

export function validateTextBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new UnsupportedRevisionError(`Blink supports text files up to 15 MiB; received ${bytes.byteLength} bytes.`);
  }
  if (bytes.includes(0)) {
    throw new UnsupportedRevisionError("Blink does not review binary content containing a NUL byte.");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedRevisionError("Blink reviews valid UTF-8 text only.");
  }
}

export async function capturePathState(
  absolutePath: string,
  options: { allowAbsent?: boolean } = {},
): Promise<PathRevision> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (isMissing(error) && options.allowAbsent) return { kind: "absent" };
    throw error;
  }

  if (info.isSymbolicLink()) throw new UnsupportedRevisionError("Blink does not review symlinks.");
  if (!info.isFile()) throw new UnsupportedRevisionError("Blink reviews regular files only.");
  if (info.size > MAX_FILE_BYTES) {
    throw new UnsupportedRevisionError(`Blink supports text files up to 15 MiB; received ${info.size} bytes.`);
  }

  const bytes = await readFile(absolutePath);
  validateTextBytes(bytes);
  const canonicalPath = await realpath(absolutePath).catch(() => undefined);
  return {
    kind: "file",
    bytes,
    hash: hashBytes(bytes),
    mode: info.mode & 0o7777,
    canonicalPath,
    device: info.dev,
    inode: info.ino,
  };
}

export async function createSnapshotDirectory(runtimeDir: string): Promise<string> {
  const snapshotsDir = join(runtimeDir, "snapshots");
  await mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  await chmod(snapshotsDir, 0o700);
  return snapshotsDir;
}

export async function persistSnapshot(snapshotsDir: string, bytes: Uint8Array): Promise<Snapshot> {
  const snapshotPath = join(snapshotsDir, randomUUID());
  const handle = await open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(snapshotPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(snapshotPath, 0o600);
  return { path: snapshotPath, byteLength: bytes.byteLength, hash: hashBytes(bytes) };
}

export function assertSnapshotPath(runtimeDir: string, snapshotPath: string): void {
  const root = resolve(runtimeDir);
  const candidate = resolve(snapshotPath);
  if (!isAbsolute(snapshotPath) || (candidate !== root && !candidate.startsWith(`${root}/`))) {
    throw new Error("Snapshot path is outside the active Blink runtime directory.");
  }
}

async function readCurrentMatchingFile(absolutePath: string, expectedHash: string): Promise<void> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    throw new RevisionConflictError(`Blink restoration refused: the reviewed file is no longer present (${String(error)}).`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RevisionConflictError("Blink restoration refused: the reviewed path changed type after review opened.");
  }
  const current = await readFile(absolutePath);
  if (hashBytes(current) !== expectedHash) {
    throw new RevisionConflictError("Blink restoration refused: the file changed after review opened; newer contents were preserved.");
  }
}

/** Caller must hold Pi's withFileMutationQueue() for absolutePath. */
export async function restorePathState(
  absolutePath: string,
  pre: PathRevision,
  expectedPostHash: string,
): Promise<void> {
  await readCurrentMatchingFile(absolutePath, expectedPostHash);

  if (pre.kind === "absent") {
    await readCurrentMatchingFile(absolutePath, expectedPostHash);
    await unlink(absolutePath);
    try {
      await lstat(absolutePath);
      throw new RevisionConflictError("Blink could not verify removal of the newly created file.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return;
  }

  const tempPath = join(dirname(absolutePath), `.blink-restore-${randomUUID()}`);
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(pre.bytes);
    await handle.sync();
    await handle.chmod(pre.mode);
    await handle.close();
    // Re-check after preparing the replacement so external changes made during
    // snapshot I/O are not overwritten by the atomic rename.
    await readCurrentMatchingFile(absolutePath, expectedPostHash);
    await rename(tempPath, absolutePath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const restored = await readFile(absolutePath);
  if (hashBytes(restored) !== pre.hash) {
    throw new Error("Blink restored the file but byte verification failed.");
  }
}
