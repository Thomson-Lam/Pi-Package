import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type BlinkMode = "off" | "slow" | "blitz";

type ToolResult = { content: unknown[]; details?: unknown; terminate?: boolean };
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => unknown;
  renderShell?: "default" | "self";
  executionMode?: "parallel" | "sequential";
  execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: { cwd: string }): Promise<ToolResult>;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
};

interface SlowToolInput {
  toolName: "edit" | "write";
  toolCallId: string;
  params: any;
  signal: AbortSignal | undefined;
  ctx: { cwd: string };
  executeBuiltin: () => Promise<ToolResult>;
}

export interface PreparedBlitzMutation {
  preparationId: string;
  absolutePath: string;
}

interface BlitzVersionInput {
  toolName: "edit" | "write";
  toolCallId: string;
  preparation: PreparedBlitzMutation;
  absolutePath: string;
  bytes: Buffer;
  firstChangedLine: number;
  result: ToolResult;
  ctx: { cwd: string };
}

export interface BlinkToolDependencies {
  initialCwd: string;
  getMode(): BlinkMode;
  createEditDefinition(cwd: string, options?: { operations?: any }): ToolDefinition;
  createWriteDefinition(cwd: string, options?: { operations?: any }): ToolDefinition;
  runSlow(input: SlowToolInput): Promise<ToolResult>;
  prepareBlitzMutation(absolutePath: string, ctx: { cwd: string }): Promise<PreparedBlitzMutation>;
  discardBlitzMutation(preparation: PreparedBlitzMutation): void;
  enqueueBlitzVersion(input: BlitzVersionInput): void;
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolveNext) => { release = resolveNext; });
    const previous = this.tail;
    this.tail = previous.then(() => next, () => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function absoluteToolPath(rawPath: string, cwd: string): string {
  return resolve(cwd, rawPath.startsWith("@") ? rawPath.slice(1) : rawPath);
}

export function createBlinkToolDefinitions(deps: BlinkToolDependencies): { edit: ToolDefinition; write: ToolDefinition } {
  const editSource = deps.createEditDefinition(deps.initialCwd);
  const writeSource = deps.createWriteDefinition(deps.initialCwd);
  const slowMutex = new AsyncMutex();

  const edit: ToolDefinition = {
    ...editSource,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mode = deps.getMode();
      if (mode === "off") {
        return deps.createEditDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (mode === "slow") {
        return slowMutex.run(() => deps.runSlow({
          toolName: "edit",
          toolCallId,
          params,
          signal,
          ctx,
          executeBuiltin: () => deps.createEditDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx),
        }));
      }

      const absolutePath = absoluteToolPath(params.path, ctx.cwd);
      const preparationPromise = deps.prepareBlitzMutation(absolutePath, ctx);
      let exactOutput: Buffer | undefined;
      const definition = deps.createEditDefinition(ctx.cwd, {
        operations: {
          async readFile(path: string) {
            await preparationPromise;
            return readFile(path);
          },
          access: (path: string) => access(path, constants.R_OK | constants.W_OK),
          async writeFile(path: string, content: string) {
            exactOutput = Buffer.from(content, "utf8");
            await writeFile(path, content, "utf8");
          },
        },
      });
      const preparation = await preparationPromise;
      try {
        const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
        if (!exactOutput) throw new Error("Blink could not capture the successful edit output.");
        deps.enqueueBlitzVersion({
          toolName: "edit",
          toolCallId,
          preparation,
          absolutePath,
          bytes: Buffer.from(exactOutput),
          firstChangedLine: Number((result.details as any)?.firstChangedLine) || 1,
          result,
          ctx,
        });
        return result;
      } catch (error) {
        deps.discardBlitzMutation(preparation);
        throw error;
      }
    },
  };

  const write: ToolDefinition = {
    ...writeSource,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mode = deps.getMode();
      if (mode === "off") {
        return deps.createWriteDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (mode === "slow") {
        return slowMutex.run(() => deps.runSlow({
          toolName: "write",
          toolCallId,
          params,
          signal,
          ctx,
          executeBuiltin: () => deps.createWriteDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx),
        }));
      }

      const absolutePath = absoluteToolPath(params.path, ctx.cwd);
      const preparation = await deps.prepareBlitzMutation(absolutePath, ctx);
      const exactOutput = Buffer.from(params.content, "utf8");
      try {
        const result = await deps.createWriteDefinition(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
        deps.enqueueBlitzVersion({
          toolName: "write",
          toolCallId,
          preparation,
          absolutePath,
          bytes: exactOutput,
          firstChangedLine: 0,
          result,
          ctx,
        });
        return result;
      } catch (error) {
        deps.discardBlitzMutation(preparation);
        throw error;
      }
    },
  };

  return { edit, write };
}
