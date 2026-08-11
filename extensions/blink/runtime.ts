import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAX_FILE_BYTES,
  RevisionConflictError,
  UnsupportedRevisionError,
  capturePathState,
  createSnapshotDirectory,
  filesystemKey,
  hashBytes,
  normalizeToolPath,
  persistSnapshot,
  restorePathState,
  revisionIdentity,
  validateTextBytes,
  type FileIdentity,
  type PathRevision,
  type Snapshot,
} from "./revisions.ts";
import { BlinkJsonlServer, createRuntimeResources, type Envelope, type RuntimeResources } from "./protocol.ts";
import { TmuxAdapter } from "./tmux.ts";

export interface BlinkFeedback {
  schemaVersion: 1;
  reviewId: string;
  mode: "slow" | "blitz";
  path: string;
  versionId?: number;
  range?: { startLine: number; endLine: number };
  comment: string;
  createdAt: number;
}

export interface BlinkFeedbackSink {
  id: string;
  label: string;
  submit(item: BlinkFeedback): Promise<void>;
}

type QueueMutation = <T>(path: string, operation: () => Promise<T>) => Promise<T>;
type ToolResult = { content: any[]; details?: any; terminate?: boolean };

interface SlowInput {
  toolName: "edit" | "write";
  toolCallId: string;
  params: any;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
  executeBuiltin(): Promise<ToolResult>;
}

export interface PreparedMutation {
  preparationId: string;
  absolutePath: string;
}

interface VersionInput {
  toolName: "edit" | "write";
  toolCallId: string;
  preparation: PreparedMutation;
  absolutePath: string;
  bytes: Buffer;
  firstChangedLine: number;
  result: ToolResult;
  ctx: ExtensionContext;
}

interface PendingPreparation extends PreparedMutation {
  pre: PathRevision;
}

interface RetainedVersion {
  versionId: number;
  fileId: string;
  generation: number;
  snapshot: Snapshot;
  byteLength: number;
  toolCallId: string;
  firstChangedLine: number;
  createdAt: number;
  unread: boolean;
  displayPath: string;
  absolutePath: string;
  canonicalPath?: string;
  filesystemKey?: string;
  originKind: "file" | "absent";
  originSnapshotPath?: string;
}

interface FileRecord {
  fileId: string;
  generation: number;
  absolutePaths: Set<string>;
  canonicalPaths: Set<string>;
  filesystemKeys: Set<string>;
  baselineKind: "file" | "absent";
  baselineSnapshot?: Snapshot;
  latest?: RetainedVersion;
  lastTouchedAt: number;
}

interface PendingSlow {
  transactionId: string;
  toolCallId: string;
  absolutePath: string;
  displayPath: string;
  pre: PathRevision;
  post: PathRevision & { kind: "file" };
  preSnapshot?: Snapshot;
  postSnapshot: Snapshot;
  firstChangedLine: number;
  result: ToolResult;
  settled: boolean;
  resolve(value: { action: "accept" | "reject"; comment?: string; requestId?: string }): void;
  reject(error: Error): void;
}

export interface RuntimeOptions {
  mode: "slow" | "blitz";
  cwd: string;
  ownerPane: string;
  reviewScript: string;
  pi: ExtensionAPI;
  queueMutation: QueueMutation;
  sinks: Map<string, BlinkFeedbackSink>;
  startupTimeoutMs?: number;
}

const MAX_RETAINED_FILES = 100;
const MAX_RUNTIME_BYTES = 100 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export class BlinkRuntime {
  readonly reviewId = randomUUID();
  readonly mode: "slow" | "blitz";
  private readonly initialCwd: string;
  private readonly ownerPane: string;
  private readonly reviewScript: string;
  private readonly pi: ExtensionAPI;
  private readonly queueMutation: QueueMutation;
  private readonly sinks: Map<string, BlinkFeedbackSink>;
  private readonly startupTimeoutMs: number;
  private resources?: RuntimeResources;
  private server?: BlinkJsonlServer;
  private tmux?: TmuxAdapter;
  private context?: ExtensionContext;
  private closing = false;
  private cleanupPromise?: Promise<void>;
  private preparations = new Map<string, PendingPreparation>();
  private files = new Map<string, FileRecord>();
  private fileIdByAbsolutePath = new Map<string, string>();
  private fileIdByCanonicalPath = new Map<string, string>();
  private fileIdByFilesystemKey = new Map<string, string>();
  private versions: RetainedVersion[] = [];
  private nextVersionId = 1;
  private snapshotByteLengths = new Map<string, number>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private pendingSlow?: PendingSlow;
  private slowTerminal?: Promise<void>;
  private clientReady = false;
  private recentRequests = new Map<string, { type: string; payload: any }>();
  private abortRequested = false;
  private clientClosePromise?: Promise<void>;
  private resolveClientClose?: () => void;
  private clientCloseTimer?: NodeJS.Timeout;
  private clientCloseCompleting?: Promise<void>;
  private clientCloseEpoch = 0;

  constructor(options: RuntimeOptions) {
    this.mode = options.mode;
    this.initialCwd = options.cwd;
    this.ownerPane = options.ownerPane;
    this.reviewScript = options.reviewScript;
    this.pi = options.pi;
    this.queueMutation = options.queueMutation;
    this.sinks = options.sinks;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5000;
  }

  setContext(ctx: ExtensionContext): void {
    this.context = ctx;
  }

  agentStarted(ctx: ExtensionContext): void {
    this.context = ctx;
    this.abortRequested = false;
  }

  get retainedCount(): number {
    return this.versions.length;
  }

  sinksChanged(): void {
    this.server?.send("sink_list_changed", { sinks: [...this.sinks.values()].map(({ id, label }) => ({ id, label })) });
  }

  private beginClientClose(): void {
    if (this.clientClosePromise) return;
    this.clientCloseEpoch++;
    this.clientClosePromise = new Promise<void>((resolve) => { this.resolveClientClose = resolve; });
  }

  private armClientCloseTimeout(): void {
    if (!this.clientClosePromise || this.clientCloseTimer) return;
    this.clientCloseTimer = setTimeout(() => { void this.completeClientClose(); }, 2000);
    this.clientCloseTimer.unref?.();
  }

  private completeClientClose(): Promise<void> {
    if (!this.clientClosePromise) return Promise.resolve();
    if (this.clientCloseCompleting) return this.clientCloseCompleting;
    this.clientCloseCompleting = (async () => {
      if (this.clientCloseTimer) clearTimeout(this.clientCloseTimer);
      this.clientCloseTimer = undefined;
      await this.tmux?.close().catch(() => undefined);
      const resolve = this.resolveClientClose;
      this.resolveClientClose = undefined;
      this.clientClosePromise = undefined;
      resolve?.();
    })().finally(() => { this.clientCloseCompleting = undefined; });
    return this.clientCloseCompleting;
  }

  private async waitForClientClose(): Promise<void> {
    await this.clientClosePromise;
  }

  private checkpointBlitzState(): Promise<{ removedFiles: number; removedVersions: number }> {
    const operation = this.deliveryTail.then(async () => {
      const removedFiles = this.files.size;
      const removedVersions = this.versions.length;
      let resetError: unknown;
      try {
        if (this.resources) {
          await rm(this.resources.snapshotsDir, { recursive: true, force: true });
          await createSnapshotDirectory(this.resources.runtimeDir);
        }
      } catch (error) {
        resetError = error;
      }
      this.files.clear();
      this.fileIdByAbsolutePath.clear();
      this.fileIdByCanonicalPath.clear();
      this.fileIdByFilesystemKey.clear();
      this.versions = [];
      this.snapshotByteLengths.clear();
      this.updateStatus();
      if (resetError) throw resetError;
      return { removedFiles, removedVersions };
    });
    this.deliveryTail = operation.then(
      () => undefined,
      (error) => this.notify(`Blink checkpoint failed: ${errorMessage(error)}`, "error"),
    );
    return operation;
  }

  async prepareMutation(absolutePath: string): Promise<PreparedMutation> {
    if (this.closing) throw new Error("Blink runtime is closing.");
    const preparationId = randomUUID();
    const pre = await capturePathState(absolutePath, { allowAbsent: true });
    const preparation: PendingPreparation = { preparationId, absolutePath, pre };
    this.preparations.set(preparationId, preparation);
    return { preparationId, absolutePath };
  }

  discardMutation(preparation: PreparedMutation): void {
    this.preparations.delete(preparation.preparationId);
  }

  enqueueVersion(input: VersionInput): void {
    if (this.closing) {
      this.discardMutation(input.preparation);
      return;
    }
    const versionId = this.nextVersionId++;
    this.context = input.ctx;
    const immutable = { ...input, bytes: Buffer.from(input.bytes), versionId, closeEpoch: this.clientCloseEpoch };
    this.deliveryTail = this.deliveryTail
      .then(() => this.deliverVersion(immutable))
      .catch((error) => {
        this.discardMutation(input.preparation);
        this.notify(`Blink skipped review version ${versionId}: ${errorMessage(error)}`, "error");
      });
  }

  private async liveFilesystemAlias(record: FileRecord, key: string): Promise<boolean> {
    for (const path of record.absolutePaths) {
      try {
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink() && `${info.dev}:${info.ino}` === key) return true;
      } catch { /* A stale alias is not evidence that an inode still belongs to this record. */ }
    }
    return false;
  }

  private async resolveFile(identity: FileIdentity, pre: PathRevision): Promise<FileRecord> {
    const fsKey = filesystemKey(identity);
    const pathId = this.fileIdByAbsolutePath.get(identity.absolutePath)
      ?? (identity.canonicalPath ? this.fileIdByCanonicalPath.get(identity.canonicalPath) : undefined);
    const candidateFsId = fsKey ? this.fileIdByFilesystemKey.get(fsKey) : undefined;
    const candidateFsRecord = candidateFsId ? this.files.get(candidateFsId) : undefined;
    const fsId = !pathId && fsKey && candidateFsRecord && await this.liveFilesystemAlias(candidateFsRecord, fsKey)
      ? candidateFsId
      : undefined;
    const fileId = pathId ?? fsId;
    let record = fileId ? this.files.get(fileId) : undefined;
    if (!record) {
      record = {
        fileId: randomUUID(),
        generation: 1,
        absolutePaths: new Set(),
        canonicalPaths: new Set(),
        filesystemKeys: new Set(),
        baselineKind: pre.kind,
        lastTouchedAt: Date.now(),
      };
      this.files.set(record.fileId, record);
    }
    this.registerIdentity(record, identity);
    return record;
  }

  private registerIdentity(record: FileRecord, identity: FileIdentity): void {
    record.absolutePaths.add(identity.absolutePath);
    this.fileIdByAbsolutePath.set(identity.absolutePath, record.fileId);
    if (identity.canonicalPath) {
      record.canonicalPaths.add(identity.canonicalPath);
      this.fileIdByCanonicalPath.set(identity.canonicalPath, record.fileId);
    }
    const fsKey = filesystemKey(identity);
    if (fsKey) {
      record.filesystemKeys.add(fsKey);
      this.fileIdByFilesystemKey.set(fsKey, record.fileId);
    }
  }

  private preparationMatchesLatest(pre: PathRevision, latest: RetainedVersion): boolean {
    return pre.kind === "file" && pre.hash === latest.snapshot.hash;
  }

  private async deliverVersion(input: VersionInput & { versionId: number; closeEpoch: number }): Promise<void> {
    if (this.closing) return;
    validateTextBytes(input.bytes);
    const preparation = this.preparations.get(input.preparation.preparationId);
    this.preparations.delete(input.preparation.preparationId);
    if (!preparation || preparation.absolutePath !== input.absolutePath) {
      throw new Error("Blink mutation preparation is missing or does not match the committed path.");
    }
    const resources = await this.ensureInfrastructure();
    if (this.closing) return;
    await createSnapshotDirectory(resources.runtimeDir);

    const identity = revisionIdentity(input.absolutePath, preparation.pre);
    const record = await this.resolveFile(identity, preparation.pre);
    const previous = record.latest;
    const replacedVersionId = previous?.versionId;
    const discontinuity = Boolean(previous && !this.preparationMatchesLatest(preparation.pre, previous));
    const nextGeneration = discontinuity ? record.generation + 1 : record.generation;
    const nextBaselineKind = discontinuity ? preparation.pre.kind : record.baselineKind;
    const oldBaselineSnapshot = record.baselineSnapshot;
    let nextBaselineSnapshot = discontinuity ? undefined : oldBaselineSnapshot;
    let snapshot!: Snapshot;
    try {
      if (nextBaselineKind === "file" && !nextBaselineSnapshot) {
        if (preparation.pre.kind !== "file") throw new Error("Blink file baseline is unavailable.");
        nextBaselineSnapshot = this.rememberSnapshot(await persistSnapshot(resources.snapshotsDir, preparation.pre.bytes));
      }
      snapshot = this.rememberSnapshot(await persistSnapshot(resources.snapshotsDir, input.bytes));
    } catch (error) {
      if (nextBaselineSnapshot && nextBaselineSnapshot.path !== oldBaselineSnapshot?.path) {
        await this.removeSnapshot(nextBaselineSnapshot.path);
      }
      if (!record.latest && !record.baselineSnapshot) {
        this.removeIdentityIndexes(record);
        this.files.delete(record.fileId);
      }
      throw error;
    }

    const displayPath = relative(input.ctx.cwd, input.absolutePath) || input.absolutePath;
    const version: RetainedVersion = {
      versionId: input.versionId,
      fileId: record.fileId,
      generation: nextGeneration,
      snapshot,
      byteLength: input.bytes.byteLength,
      toolCallId: input.toolCallId,
      firstChangedLine: input.firstChangedLine,
      createdAt: Date.now(),
      unread: true,
      displayPath,
      absolutePath: identity.absolutePath,
      canonicalPath: identity.canonicalPath,
      filesystemKey: filesystemKey(identity),
      originKind: nextBaselineKind,
      originSnapshotPath: nextBaselineSnapshot?.path,
    };
    if (previous) this.versions = this.versions.filter((item) => item.versionId !== previous.versionId);
    record.generation = nextGeneration;
    record.baselineKind = nextBaselineKind;
    record.baselineSnapshot = nextBaselineSnapshot;
    record.latest = version;
    record.lastTouchedAt = version.createdAt;
    this.versions.push(version);
    if (previous) await this.removeSnapshot(previous.snapshot.path);
    if (oldBaselineSnapshot && oldBaselineSnapshot.path !== nextBaselineSnapshot?.path) {
      await this.removeSnapshot(oldBaselineSnapshot.path);
    }

    const evicted = await this.evictToLimits();
    this.updateStatus();
    if (this.closing) return;
    if (input.closeEpoch === this.clientCloseEpoch) await this.waitForClientClose();
    if (this.closing) return;
    try {
      await this.tmux!.ensure(this.reviewId, "blitz", resources.socketPath);
      if (this.closing) {
        await this.tmux?.close().catch(() => undefined);
        return;
      }
    } catch (error) {
      if (this.closing) return;
      this.notify(`Blink retained version ${version.versionId}, but the review pane could not open: ${errorMessage(error)}`, "error");
      return;
    }
    if (evicted.length) {
      for (const item of evicted) this.server?.send("file_evicted", item);
      this.notify(`Blink evicted ${evicted.length} old reviewed file(s) to enforce history limits.`, "warning");
    }
    if (this.files.has(record.fileId)) {
      this.server?.send("file_version_upserted", {
        replacedVersionId,
        version: this.versionPayload(version),
      });
    }
    this.updateStatus();
  }

  private rememberSnapshot(snapshot: Snapshot): Snapshot {
    this.snapshotByteLengths.set(snapshot.path, snapshot.byteLength);
    return snapshot;
  }

  private runtimeBytes(): number {
    let total = 0;
    for (const byteLength of this.snapshotByteLengths.values()) total += byteLength;
    return total;
  }

  private async removeSnapshot(path: string | undefined): Promise<void> {
    if (!path) return;
    await rm(path, { force: true }).catch(() => undefined);
    this.snapshotByteLengths.delete(path);
  }

  private removeIdentityIndexes(record: FileRecord): void {
    for (const path of record.absolutePaths) {
      if (this.fileIdByAbsolutePath.get(path) === record.fileId) this.fileIdByAbsolutePath.delete(path);
    }
    for (const path of record.canonicalPaths) {
      if (this.fileIdByCanonicalPath.get(path) === record.fileId) this.fileIdByCanonicalPath.delete(path);
    }
    for (const key of record.filesystemKeys) {
      if (this.fileIdByFilesystemKey.get(key) === record.fileId) this.fileIdByFilesystemKey.delete(key);
    }
  }

  private async evictFile(record: FileRecord): Promise<{ fileId: string; versionId?: number }> {
    const versionId = record.latest?.versionId;
    if (versionId !== undefined) this.versions = this.versions.filter((item) => item.versionId !== versionId);
    await this.removeSnapshot(record.latest?.snapshot.path);
    await this.removeSnapshot(record.baselineSnapshot?.path);
    this.removeIdentityIndexes(record);
    this.files.delete(record.fileId);
    return { fileId: record.fileId, versionId };
  }

  private async evictToLimits(): Promise<Array<{ fileId: string; versionId?: number }>> {
    const evicted: Array<{ fileId: string; versionId?: number }> = [];
    while (this.versions.length > MAX_RETAINED_FILES || this.runtimeBytes() > MAX_RUNTIME_BYTES) {
      const oldest = this.versions[0];
      if (!oldest) break;
      const record = this.files.get(oldest.fileId);
      if (!record) {
        this.versions.shift();
        continue;
      }
      evicted.push(await this.evictFile(record));
    }
    return evicted;
  }

  private versionPayload(version: RetainedVersion): any {
    return {
      versionId: version.versionId,
      fileId: version.fileId,
      generation: version.generation,
      displayPath: version.displayPath,
      absolutePath: version.absolutePath,
      canonicalPath: version.canonicalPath,
      filesystemKey: version.filesystemKey,
      snapshotPath: version.snapshot.path,
      byteLength: version.byteLength,
      toolCallId: version.toolCallId,
      firstChangedLine: version.firstChangedLine,
      createdAt: version.createdAt,
      unread: version.unread,
      originKind: version.originKind,
      originSnapshotPath: version.originSnapshotPath,
    };
  }

  async runSlow(input: SlowInput): Promise<ToolResult> {
    if (this.closing) throw new Error("Blink runtime is closing.");
    this.context = input.ctx;
    if (input.signal?.aborted) throw new Error("Operation aborted");
    const absolutePath = normalizeToolPath(input.params.path, input.ctx.cwd);
    const pre = await capturePathState(absolutePath, { allowAbsent: input.toolName === "write" });
    if (input.toolName === "write") validateTextBytes(Buffer.from(input.params.content, "utf8"));
    const result = await input.executeBuiltin();
    let post: PathRevision;
    try {
      post = await capturePathState(absolutePath);
      if (post.kind !== "file") throw new UnsupportedRevisionError("Blink expected a regular post-state file.");
    } catch (error) {
      const currentHash = await this.currentHashIfRegular(absolutePath);
      if (!currentHash) {
        if (!input.ctx.isIdle()) input.ctx.abort();
        throw new RevisionConflictError(`Blink could not review or restore the resulting path because it changed type or disappeared: ${errorMessage(error)}`);
      }
      await this.queueMutation(absolutePath, () => restorePathState(absolutePath, pre, currentHash));
      throw new Error(`Blink could not review the resulting file and restored its pre-tool state: ${errorMessage(error)}`);
    }
    const resources = await this.ensureInfrastructure();
    const preSnapshot = pre.kind === "file" ? await persistSnapshot(resources.snapshotsDir, pre.bytes) : undefined;
    const postSnapshot = await persistSnapshot(resources.snapshotsDir, post.bytes);
    const transactionId = randomUUID();
    const displayPath = relative(input.ctx.cwd, absolutePath) || absolutePath;
    const disposition = new Promise<{ action: "accept" | "reject"; comment?: string; requestId?: string }>((resolve, reject) => {
      this.pendingSlow = {
        transactionId,
        toolCallId: input.toolCallId,
        absolutePath,
        displayPath,
        pre,
        post,
        preSnapshot,
        postSnapshot,
        firstChangedLine: input.toolName === "edit" ? (Number(result.details?.firstChangedLine) || 1) : (pre.kind === "absent" ? 1 : 0),
        result,
        settled: false,
        resolve,
        reject,
      };
    });
    // A client can disconnect before pane startup finishes and before this function
    // reaches its await below. Attach a handler immediately to avoid a transient
    // unhandled rejection while preserving the original promise's rejection.
    void disposition.catch(() => undefined);
    const pending = this.pendingSlow;
    const abort = () => void this.cancelPendingSlow("Blink review was cancelled.");
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      this.clientReady = false;
      await this.tmux!.create(this.reviewId, "slow", resources.socketPath);
      await this.waitForClientReady();
      const decision = await disposition;
      if (decision.action === "reject") {
        throw new Error(decision.comment ? `Blink change was rejected: ${decision.comment}` : "Blink change was rejected. The file was restored.");
      }
      if (!decision.comment) return result;
      return {
        ...result,
        content: [...result.content, { type: "text", text: `Human Blink feedback (${displayPath}): ${decision.comment}` }],
        details: result.details,
      };
    } catch (error) {
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve({ action: "reject" });
        await this.restoreSlow(pending);
        throw new Error(`Blink review was cancelled. The file change was restored. ${errorMessage(error)}`);
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (this.pendingSlow === pending) this.pendingSlow = undefined;
      await this.tmux?.close().catch(() => undefined);
      await Promise.all([preSnapshot?.path, postSnapshot.path].filter(Boolean).map((path) => rm(path!, { force: true }).catch(() => undefined)));
    }
  }

  private async currentHashIfRegular(path: string): Promise<string | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      return hashBytes(await readFile(path));
    } catch { return undefined; }
  }

  private async restoreSlow(transaction: PendingSlow): Promise<void> {
    try {
      await this.queueMutation(transaction.absolutePath, () => restorePathState(transaction.absolutePath, transaction.pre, transaction.post.hash));
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        if (this.context && !this.context.isIdle()) this.context.abort();
        throw error;
      }
      throw error;
    }
  }

  private async cancelPendingSlow(message: string): Promise<void> {
    const pending = this.pendingSlow;
    if (!pending) return;
    if (pending.settled) {
      await this.slowTerminal?.catch(() => undefined);
      return;
    }
    pending.settled = true;
    const terminal = (async () => {
      try {
        await this.restoreSlow(pending);
        pending.reject(new Error(`${message} The file change was restored.`));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    let tracked: Promise<void>;
    tracked = terminal.finally(() => {
      if (this.slowTerminal === tracked) this.slowTerminal = undefined;
    });
    this.slowTerminal = tracked;
    await tracked;
  }

  private acceptPendingSlowOnDisconnect(): void {
    const pending = this.pendingSlow;
    if (!pending || pending.settled) return;
    pending.settled = true;
    pending.resolve({ action: "accept" });
  }

  private async waitForClientReady(): Promise<void> {
    const started = Date.now();
    while (!this.clientReady && Date.now() - started < this.startupTimeoutMs && !this.closing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.clientReady) return;
    const alive = await this.tmux?.verify();
    await this.cancelPendingSlow(alive ? "Blink Neovim did not become ready." : "Blink review pane exited during startup.");
  }

  private async ensureInfrastructure(): Promise<RuntimeResources> {
    if (this.resources) return this.resources;
    const resources = await createRuntimeResources();
    if (this.closing) {
      await rm(resources.runtimeDir, { recursive: true, force: true });
      throw new Error("Blink runtime closed during startup.");
    }
    const tmux = new TmuxAdapter({
      ownerPane: this.ownerPane,
      cwd: this.context?.cwd ?? this.initialCwd,
      reviewScript: this.reviewScript,
      exec: (command, args) => this.pi.exec(command, args),
    });
    const server = new BlinkJsonlServer({
      socketPath: resources.socketPath,
      reviewId: this.reviewId,
      mode: this.mode,
      onMessage: (message) => this.handleMessage(message),
      onDisconnect: () => {
        const wasReady = this.clientReady;
        this.clientReady = false;
        if (this.mode !== "slow") return this.completeClientClose();
        if (wasReady) {
          this.acceptPendingSlowOnDisconnect();
          return undefined;
        }
        return this.cancelPendingSlow("Blink review was cancelled because Neovim disconnected before it became ready.");
      },
      onError: (error) => this.notify(`Blink protocol error: ${error.message}`, "error"),
    });
    try {
      await server.start();
    } catch (error) {
      await server.close().catch(() => undefined);
      await rm(resources.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    if (this.closing) {
      await server.close().catch(() => undefined);
      await rm(resources.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Blink runtime closed during startup.");
    }
    this.resources = resources;
    this.tmux = tmux;
    this.server = server;
    return resources;
  }

  private async handleMessage(message: Envelope): Promise<void> {
    if (this.closing) return;
    if (typeof message.requestId !== "string" || message.requestId.trim().length === 0) {
      this.server?.send("error", { code: "missing_request_id", message: "Blink client actions require a request ID." });
      return;
    }
    if (this.recentRequests.has(message.requestId)) {
      const cached = this.recentRequests.get(message.requestId)!;
      this.server?.send(cached.type, cached.payload, message.requestId);
      return;
    }
    const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as any;
    if (message.type === "client_ready") {
      if (typeof payload.nvimVersion !== "string" || payload.nvimVersion.length === 0) {
        return this.reply(message, "error", { code: "invalid_client_ready", message: "A Neovim version is required." });
      }
      this.clientReady = true;
      this.server?.send("hello", {
        mode: this.mode,
        cwd: this.context?.cwd ?? this.initialCwd,
        sinks: [...this.sinks.values()].map(({ id, label }) => ({ id, label })),
      });
      return;
    }
    if (!this.clientReady) return this.reply(message, "error", { code: "not_ready", message: "client_ready is required first." });
    if (message.type === "request_state") {
      if (this.mode === "slow") {
        const transaction = this.pendingSlow ? this.slowPayload(this.pendingSlow) : undefined;
        this.server?.send("state_snapshot", { mode: "slow", transaction });
      } else {
        this.server?.send("state_snapshot", { mode: "blitz", versions: this.versions.map((version) => this.versionPayload(version)) });
      }
      return;
    }
    if (this.mode === "blitz" && ["client_checkpoint_close", "client_retain_close", "client_closing"].includes(message.type)) {
      const action = message.type === "client_checkpoint_close" ? "checkpoint" : "retain";
      this.beginClientClose();
      this.recentRequests.set(message.requestId, { type: "client_close_pending", payload: { action } });
      if (action === "retain") {
        this.reply(message, "client_close_result", {
          action,
          reset: false,
          retainedCount: this.retainedCount,
        });
        this.armClientCloseTimeout();
        return;
      }
      try {
        const reset = await this.checkpointBlitzState();
        this.reply(message, "client_close_result", {
          action,
          reset: true,
          retainedCount: this.retainedCount,
          ...reset,
        });
      } catch (error) {
        this.reply(message, "client_close_result", {
          action,
          reset: false,
          retainedCount: this.retainedCount,
          error: `Blink checkpoint failed: ${errorMessage(error)}`,
        });
      }
      this.armClientCloseTimeout();
      return;
    }
    if (this.mode === "slow" && message.type === "client_closing") {
      const pending = this.pendingSlow;
      if (!pending || pending.settled) return this.reply(message, "slow_action_result", { settled: true, action: "dismiss" });
      pending.settled = true;
      pending.resolve({ action: "accept", requestId: message.requestId });
      return this.reply(message, "slow_action_result", { settled: true, action: "dismiss" });
    }
    if (this.mode === "slow" && ["slow_accept", "slow_reject", "slow_comment_keep", "slow_comment_reject"].includes(message.type)) {
      const pending = this.pendingSlow;
      if (!pending || payload.transactionId !== pending.transactionId || pending.settled) {
        return this.reply(message, "slow_action_result", { settled: false, error: "Blink transaction is no longer pending." });
      }
      const comment = typeof payload.comment === "string" ? payload.comment.trim() : undefined;
      if ((message.type.includes("comment")) && !comment) return this.reply(message, "slow_action_result", { settled: false, error: "A comment is required." });
      pending.settled = true;
      const reject = message.type === "slow_reject" || message.type === "slow_comment_reject";
      if (!reject) {
        pending.resolve({ action: "accept", comment, requestId: message.requestId });
        return this.reply(message, "slow_action_result", { settled: true, action: "accept" });
      }
      this.recentRequests.set(message.requestId, { type: "slow_action_result", payload: { settled: false, pending: true } });
      this.server?.send("slow_action_result", { settled: false, pending: true }, message.requestId);
      const terminal = (async () => {
        try {
          await this.restoreSlow(pending);
          this.sendSlowActionResult(message.requestId, { settled: true, action: "reject" });
          pending.resolve({ action: "reject", comment, requestId: message.requestId });
        } catch (error) {
          this.sendSlowActionResult(message.requestId, { settled: false, error: errorMessage(error) });
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      let tracked: Promise<void>;
      tracked = terminal.finally(() => {
        if (this.slowTerminal === tracked) this.slowTerminal = undefined;
      });
      this.slowTerminal = tracked;
      await tracked;
      return;
    }
    if (message.type === "submit_todo") {
      return this.submitTodo(message, payload);
    }
    if (this.mode === "blitz" && message.type === "submit_agent_feedback") {
      const version = this.versions.find((item) => item.versionId === payload.versionId && item.fileId === payload.fileId);
      if (!version || typeof payload.comment !== "string" || !payload.comment.trim()) {
        return this.reply(message, "feedback_result", { error: "Blink version/comment is invalid." });
      }
      const range = this.validRange(payload.range);
      if (payload.range !== undefined && !range) return this.reply(message, "feedback_result", { error: "Blink feedback range is invalid." });
      const text = `Blink review feedback for ${version.displayPath} (version ${version.versionId})${range ? `, lines ${range.startLine}-${range.endLine}` : ""}:\n${payload.comment.trim()}`;
      const ctx = this.context;
      this.pi.sendUserMessage(text, ctx && !ctx.isIdle() ? { deliverAs: "steer" } : undefined);
      return this.reply(message, "feedback_result", { submitted: true });
    }
    if (this.mode === "blitz" && message.type === "abort_agent") {
      const ctx = this.context;
      if (!ctx || ctx.isIdle()) return this.reply(message, "agent_abort_unavailable", { message: "Pi is idle; no agent can be aborted." });
      if (!this.abortRequested) { this.abortRequested = true; ctx.abort(); }
      return this.reply(message, "agent_abort_requested", { message: "Pi agent abort requested." });
    }
    this.reply(message, "error", { code: "unknown_action", message: `Unsupported Blink action: ${message.type}` });
  }

  private sendSlowActionResult(requestId: string | undefined, payload: any): void {
    if (requestId) this.recentRequests.set(requestId, { type: "slow_action_result", payload });
    this.server?.send("slow_action_result", payload, requestId);
  }

  private slowPayload(transaction: PendingSlow): any {
    return {
      transactionId: transaction.transactionId,
      displayPath: transaction.displayPath,
      snapshotPath: transaction.postSnapshot.path,
      originKind: transaction.pre.kind,
      originSnapshotPath: transaction.preSnapshot?.path,
      firstChangedLine: transaction.firstChangedLine,
    };
  }

  private validRange(range: any): { startLine: number; endLine: number } | undefined {
    if (!range || !Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) return undefined;
    return { startLine: range.startLine, endLine: range.endLine };
  }

  private async submitTodo(message: Envelope, payload: any): Promise<void> {
    // Reserve the request ID before awaiting a sink so a concurrent duplicate
    // cannot invoke the asynchronous sink twice.
    if (message.requestId) this.recentRequests.set(message.requestId, { type: "feedback_result", payload: { pending: true } });
    const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
    if (!comment) return this.reply(message, "feedback_result", { error: "A TODO comment is required." });
    if (payload.range !== undefined && !this.validRange(payload.range)) return this.reply(message, "feedback_result", { error: "Blink TODO range is invalid." });
    let path: string | undefined;
    let versionId: number | undefined;
    if (this.mode === "slow") {
      if (!this.pendingSlow || payload.transactionId !== this.pendingSlow.transactionId) return this.reply(message, "feedback_result", { error: "Slow transaction is not pending." });
      path = this.pendingSlow.displayPath;
    } else {
      const version = this.versions.find((item) => item.versionId === payload.versionId && item.fileId === payload.fileId);
      if (!version) return this.reply(message, "feedback_result", { error: "Blitz version is not retained." });
      path = version.displayPath;
      versionId = version.versionId;
    }
    const sinks = [...this.sinks.values()];
    const sink = payload.sinkId ? this.sinks.get(payload.sinkId) : sinks.length === 1 ? sinks[0] : undefined;
    if (!sink) return this.reply(message, "feedback_result", { error: sinks.length ? "Select a Blink feedback sink." : "No Blink TODO sink is registered." });
    try {
      await sink.submit({ schemaVersion: 1, reviewId: this.reviewId, mode: this.mode, path, versionId, range: this.validRange(payload.range), comment, createdAt: Date.now() });
      this.reply(message, "feedback_result", { submitted: true, sinkId: sink.id });
    } catch (error) {
      this.reply(message, "feedback_result", { error: `TODO submission failed: ${errorMessage(error)}` });
    }
  }

  private reply(message: Envelope, type: string, payload: any): void {
    if (message.requestId) {
      this.recentRequests.set(message.requestId, { type, payload });
      while (this.recentRequests.size > 256) this.recentRequests.delete(this.recentRequests.keys().next().value!);
    }
    this.server?.send(type, payload, message.requestId);
  }

  private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.context?.ui.notify(message, type);
  }

  private updateStatus(): void {
    if (this.mode === "blitz" && this.context) this.context.ui.setStatus("blink", this.context.ui.theme.fg("accent", `blink:blitz ${this.retainedCount}`));
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.closing = true;
      await this.cancelPendingSlow("Blink review was cancelled during cleanup.");
      await this.slowTerminal?.catch(() => undefined);
      await this.completeClientClose();
      this.server?.send("shutdown", {});
      await this.server?.close().catch(() => undefined);
      await this.tmux?.close().catch(() => undefined);
      if (this.resources) await rm(this.resources.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      this.server = undefined;
      this.tmux = undefined;
      this.resources = undefined;
      this.preparations.clear();
      this.files.clear();
      this.fileIdByAbsolutePath.clear();
      this.fileIdByCanonicalPath.clear();
      this.fileIdByFilesystemKey.clear();
      this.versions = [];
      this.pendingSlow = undefined;
      this.recentRequests.clear();
      this.snapshotByteLengths.clear();
      this.context = undefined;
    })();
    return this.cleanupPromise;
  }
}
