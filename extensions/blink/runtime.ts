import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAX_FILE_BYTES,
  RevisionConflictError,
  UnsupportedRevisionError,
  capturePathState,
  hashBytes,
  normalizeToolPath,
  persistSnapshot,
  restorePathState,
  validateTextBytes,
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

interface VersionInput {
  toolName: "edit" | "write";
  toolCallId: string;
  absolutePath: string;
  bytes: Buffer;
  firstChangedLine: number;
  result: ToolResult;
  ctx: ExtensionContext;
}

interface OriginRecord {
  path: string;
  revision?: PathRevision;
  unsupported?: string;
  fileId: string;
  snapshot?: Snapshot;
}

interface RetainedVersion {
  versionId: number;
  fileId: string;
  snapshot: Snapshot;
  byteLength: number;
  toolCallId: string;
  firstChangedLine: number;
  createdAt: number;
  unread: boolean;
  displayPath: string;
  originKind: "file" | "absent";
  originSnapshotPath?: string;
}

interface FileHistory {
  origin: OriginRecord;
  versions: RetainedVersion[];
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

const MAX_VERSIONS = 100;
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
  private origins = new Map<string, Promise<OriginRecord>>();
  private histories = new Map<string, FileHistory>();
  private versions: RetainedVersion[] = [];
  private nextVersionId = 1;
  private deliveryTail: Promise<void> = Promise.resolve();
  private pendingSlow?: PendingSlow;
  private slowTerminal?: Promise<void>;
  private clientReady = false;
  private recentRequests = new Map<string, { type: string; payload: any }>();
  private abortRequested = false;

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

  captureOrigin(absolutePath: string, _readOrigin: () => Promise<Buffer | "absent">): Promise<Buffer | "absent"> {
    let promise = this.origins.get(absolutePath);
    if (!promise) {
      const created = this.captureOriginRecord(absolutePath);
      let tracked: Promise<OriginRecord>;
      tracked = created.catch((error) => {
        if (this.origins.get(absolutePath) === tracked) this.origins.delete(absolutePath);
        throw error;
      });
      promise = tracked;
      this.origins.set(absolutePath, tracked);
    }
    return promise.then((record) => record.revision?.kind === "file" ? Buffer.from(record.revision.bytes) : "absent");
  }

  private async captureOriginRecord(absolutePath: string): Promise<OriginRecord> {
    const record: OriginRecord = { path: absolutePath, fileId: randomUUID() };
    try {
      record.revision = await capturePathState(absolutePath, { allowAbsent: true });
    } catch (error) {
      if (error instanceof UnsupportedRevisionError) record.unsupported = error.message;
      else throw error;
    }
    return record;
  }

  enqueueVersion(input: VersionInput): void {
    if (this.closing) return;
    const versionId = this.nextVersionId++;
    this.context = input.ctx;
    const immutable = { ...input, bytes: Buffer.from(input.bytes), versionId };
    this.deliveryTail = this.deliveryTail
      .then(() => this.deliverVersion(immutable))
      .catch((error) => this.notify(`Blink skipped review version ${versionId}: ${errorMessage(error)}`, "error"));
  }

  private async deliverVersion(input: VersionInput & { versionId: number }): Promise<void> {
    if (this.closing) return;
    validateTextBytes(input.bytes);
    const origin = await this.origins.get(input.absolutePath);
    if (!origin) throw new Error("Blink origin was not captured.");
    if (origin.unsupported || !origin.revision) {
      throw new UnsupportedRevisionError(origin.unsupported || "Unsupported Blink origin.");
    }
    const resources = await this.ensureInfrastructure();
    if (this.closing) return;
    let history = this.histories.get(origin.fileId);
    if (!history) {
      history = { origin, versions: [] };
      this.histories.set(origin.fileId, history);
    }
    const previous = history.versions[history.versions.length - 1];
    if (!previous && origin.revision.kind === "file" && !origin.snapshot) {
      origin.snapshot = await persistSnapshot(resources.snapshotsDir, origin.revision.bytes);
    }
    const snapshot = await persistSnapshot(resources.snapshotsDir, input.bytes);
    const displayPath = relative(input.ctx.cwd, input.absolutePath) || input.absolutePath;
    const version: RetainedVersion = {
      versionId: input.versionId,
      fileId: origin.fileId,
      snapshot,
      byteLength: input.bytes.byteLength,
      toolCallId: input.toolCallId,
      firstChangedLine: input.firstChangedLine,
      createdAt: Date.now(),
      unread: true,
      displayPath,
      originKind: previous ? "file" : origin.revision.kind,
      originSnapshotPath: previous ? previous.snapshot.path : origin.snapshot?.path,
    };
    const removedForFile = history.versions.splice(0, history.versions.length, version);
    this.versions = this.versions.filter((item) => item.fileId !== origin.fileId);
    this.versions.push(version);
    for (const removed of removedForFile) {
      if (removed.originSnapshotPath && removed.originSnapshotPath !== version.originSnapshotPath) {
        await rm(removed.originSnapshotPath, { force: true }).catch(() => undefined);
        if (origin.snapshot?.path === removed.originSnapshotPath) origin.snapshot = undefined;
      }
    }
    const evicted = await this.evictToLimits();
    this.updateStatus();
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
      for (const id of evicted) this.server?.send("version_evicted", { versionId: id });
      this.notify(`Blink evicted ${evicted.length} old review version(s) to enforce history limits.`, "warning");
    }
    this.server?.send("version_added", { version: this.versionPayload(version) });
    this.updateStatus();
  }

  private runtimeBytes(): number {
    let total = this.versions.reduce((sum, version) => sum + version.byteLength, 0);
    const counted = new Set<string>();
    for (const history of this.histories.values()) {
      for (const version of history.versions) {
        if (version.originSnapshotPath && !counted.has(version.originSnapshotPath)) {
          counted.add(version.originSnapshotPath);
          total += history.origin.snapshot?.path === version.originSnapshotPath
            ? history.origin.snapshot.byteLength
            : version.byteLength;
        }
      }
      if (history.origin.snapshot && !counted.has(history.origin.snapshot.path)) total += history.origin.snapshot.byteLength;
    }
    return total;
  }

  private async evictToLimits(): Promise<number[]> {
    const evicted: number[] = [];
    while (this.versions.length > MAX_VERSIONS || this.runtimeBytes() > MAX_RUNTIME_BYTES) {
      const version = this.versions.shift();
      if (!version) break;
      evicted.push(version.versionId);
      await rm(version.snapshot.path, { force: true }).catch(() => undefined);
      const history = this.histories.get(version.fileId);
      if (!history) continue;
      history.versions = history.versions.filter((item) => item.versionId !== version.versionId);
      if (history.versions.length === 0) {
        if (version.originSnapshotPath) await rm(version.originSnapshotPath, { force: true }).catch(() => undefined);
        if (history.origin.snapshot && history.origin.snapshot.path !== version.originSnapshotPath) {
          await rm(history.origin.snapshot.path, { force: true }).catch(() => undefined);
        }
        history.origin.snapshot = undefined;
        this.histories.delete(version.fileId);
      }
    }
    return evicted;
  }

  private versionPayload(version: RetainedVersion): any {
    return {
      versionId: version.versionId,
      fileId: version.fileId,
      displayPath: version.displayPath,
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
        if (this.mode !== "slow") return undefined;
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
    if (this.mode === "blitz" && message.type === "client_closing") return;
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
      this.server?.send("shutdown", {});
      await this.server?.close().catch(() => undefined);
      await this.tmux?.close().catch(() => undefined);
      if (this.resources) await rm(this.resources.runtimeDir, { recursive: true, force: true }).catch(() => undefined);
      this.server = undefined;
      this.tmux = undefined;
      this.resources = undefined;
      this.origins.clear();
      this.histories.clear();
      this.versions = [];
      this.pendingSlow = undefined;
      this.recentRequests.clear();
      this.context = undefined;
    })();
    return this.cleanupPromise;
  }
}
