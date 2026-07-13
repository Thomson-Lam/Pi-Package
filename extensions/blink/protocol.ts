import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

export const BLINK_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;

export interface Envelope<T = unknown> {
  protocolVersion: 1;
  type: string;
  reviewId: string;
  requestId?: string;
  payload: T;
}

export interface RuntimeResources {
  runtimeDir: string;
  snapshotsDir: string;
  socketPath: string;
}

export async function createRuntimeResources(baseDir = process.env.XDG_RUNTIME_DIR || tmpdir()): Promise<RuntimeResources> {
  await mkdir(baseDir, { recursive: true });
  const runtimeDir = await mkdtemp(join(baseDir, "pi-blink-"));
  await chmod(runtimeDir, 0o700);
  const socketPath = join(runtimeDir, "blink.sock");
  if (Buffer.byteLength(socketPath) > 100) {
    await import("node:fs/promises").then(({ rm }) => rm(runtimeDir, { recursive: true, force: true }));
    if (baseDir !== tmpdir()) return createRuntimeResources(tmpdir());
    throw new Error("Blink could not create a sufficiently short Unix socket path.");
  }
  const snapshotsDir = join(runtimeDir, "snapshots");
  await mkdir(snapshotsDir, { mode: 0o700 });
  await chmod(snapshotsDir, 0o700);
  return { runtimeDir, snapshotsDir, socketPath };
}

function parseEnvelope(line: Buffer, reviewId: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    throw new Error("Malformed Blink JSON frame.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Blink frame must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== BLINK_PROTOCOL_VERSION) throw new Error("Unsupported Blink protocol version.");
  if (candidate.reviewId !== reviewId) throw new Error("Blink review ID mismatch.");
  if (typeof candidate.type !== "string" || candidate.type.length === 0) throw new Error("Blink frame type is required.");
  if (!("payload" in candidate) || candidate.payload === undefined) throw new Error("Blink frame payload is required.");
  if (candidate.requestId !== undefined && typeof candidate.requestId !== "string") throw new Error("Blink request ID must be a string.");
  return candidate as unknown as Envelope;
}

interface ServerOptions {
  socketPath: string;
  reviewId: string;
  mode: "slow" | "blitz";
  onMessage(message: Envelope): Promise<void> | void;
  onDisconnect?(): Promise<void> | void;
  onError?(error: Error): void;
}

export class BlinkJsonlServer {
  private server: Server | undefined;
  private client: Socket | undefined;
  private acceptedClient = false;
  private closePromise: Promise<void> | undefined;
  private readonly options: ServerOptions;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListen); reject(error); };
      const onListen = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  hasClient(): boolean {
    return Boolean(this.client && !this.client.destroyed);
  }

  private accept(socket: Socket): void {
    if (this.client && !this.client.destroyed) {
      const error = this.makeEnvelope("error", { code: "client_rejected", message: "Blink already has an active client." });
      socket.end(`${JSON.stringify(error)}\n`);
      return;
    }

    this.client = socket;
    this.acceptedClient = true;
    let buffer = Buffer.alloc(0);
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      if (this.client === socket) this.client = undefined;
      if (this.acceptedClient) Promise.resolve(this.options.onDisconnect?.()).catch((error) => this.report(error));
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_FRAME_BYTES && buffer.indexOf(0x0a) < 0) {
        this.rejectSocket(socket, "Blink frame exceeds 256 KiB.");
        return;
      }
      while (!socket.destroyed) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.byteLength > MAX_FRAME_BYTES) {
          this.rejectSocket(socket, "Blink frame exceeds 256 KiB.");
          return;
        }
        if (line.byteLength === 0) continue;
        let message: Envelope;
        try {
          message = parseEnvelope(line, this.options.reviewId);
        } catch (error) {
          this.rejectSocket(socket, error instanceof Error ? error.message : String(error));
          return;
        }
        Promise.resolve(this.options.onMessage(message)).catch((error) => this.report(error));
      }
    });
    socket.once("close", disconnect);
    socket.once("error", (error) => this.report(error));
  }

  private rejectSocket(socket: Socket, message: string): void {
    if (socket.destroyed) return;
    const timer = setTimeout(() => socket.destroy(), 50);
    timer.unref?.();
    socket.write(`${JSON.stringify(this.makeEnvelope("error", { code: "invalid_frame", message }))}\n`, () => {
      clearTimeout(timer);
      socket.destroy();
    });
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private makeEnvelope<T>(type: string, payload: T, requestId?: string): Envelope<T> {
    return { protocolVersion: 1, type, reviewId: this.options.reviewId, ...(requestId ? { requestId } : {}), payload };
  }

  send<T>(type: string, payload: T, requestId?: string): boolean {
    const client = this.client;
    if (!client || client.destroyed || !client.writable) return false;
    client.write(`${JSON.stringify(this.makeEnvelope(type, payload, requestId))}\n`);
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const client = this.client;
      this.client = undefined;
      if (client && !client.destroyed) client.destroy();
      const server = this.server;
      this.server = undefined;
      if (!server) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
        server.close(() => { clearTimeout(timer); resolve(); });
      });
    })();
    return this.closePromise;
  }
}
