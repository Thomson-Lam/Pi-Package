import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { RunLedger } from "./ledger.js";
import { appendLedgerEvent, writeAgentArtifact } from "./ledger.js";
import { resolveMuonSubagentSkill } from "./subagent-skills.js";

export interface MuonAgentTask {
  agent: string;
  task: string;
  cwd?: string;
  phaseId?: string;
}

export interface MuonAgentResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  output: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  phaseId?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
}

export interface RunAgentInput {
  defaultCwd: string;
  agents: AgentConfig[];
  task: MuonAgentTask;
  ledger: RunLedger;
  depth: number;
  maxDepth: number;
  signal?: AbortSignal;
  onUpdate?: (result: MuonAgentResult) => void;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) if (part.type === "text") return part.text;
    }
  }
  return "";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "muon-agent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

export async function runSingleMuonAgent(input: RunAgentInput): Promise<MuonAgentResult> {
  if (input.depth >= input.maxDepth) {
    throw new Error(`Muon maxDepth reached: depth ${input.depth}, maxDepth ${input.maxDepth}`);
  }

  const agent = input.agents.find((a) => a.name === input.task.agent);
  if (!agent) throw new Error(`Unknown agent: ${input.task.agent}`);

  await appendLedgerEvent(input.ledger, { type: "agent_started", phaseId: input.task.phaseId, agent: agent.name, message: input.task.task });
  await writeAgentArtifact(input.ledger, { phaseId: input.task.phaseId, agent: agent.name, kind: "prompt", content: input.task.task });

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (agent.skills && agent.skills.length > 0) {
    args.push("--no-skills");
    for (const skill of agent.skills) args.push("--skill", resolveMuonSubagentSkill(skill));
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const current: MuonAgentResult = {
    agent: agent.name,
    agentSource: agent.source,
    task: input.task.task,
    exitCode: 0,
    messages: [],
    stderr: "",
    output: "",
    model: agent.model,
    phaseId: input.task.phaseId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  try {
    const guardPrompt = `\n\nMuon depth: ${input.depth + 1}/${input.maxDepth}. Do not call muon_workflow or muon_subagent unless the parent task explicitly instructs you and the depth limit allows it.`;
    const tmp = await writePromptToTempFile(agent.name, `${agent.systemPrompt.trim()}${guardPrompt}`);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
    args.push(`Task: ${input.task.task}`);

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: input.task.cwd ?? input.defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MUON_DEPTH: String(input.depth + 1), MUON_PARENT_RUN_ID: input.ledger.runId },
      });

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          current.messages.push(msg);
          if (msg.role === "assistant") {
            current.usage.turns += 1;
            const usage = msg.usage;
            if (usage) {
              current.usage.input += usage.input || 0;
              current.usage.output += usage.output || 0;
              current.usage.cacheRead += usage.cacheRead || 0;
              current.usage.cacheWrite += usage.cacheWrite || 0;
              current.usage.cost += usage.cost?.total || 0;
              current.usage.contextTokens = usage.totalTokens || 0;
            }
            current.stopReason = msg.stopReason;
            current.errorMessage = msg.errorMessage;
            current.model = current.model ?? msg.model;
          }
          current.output = getFinalOutput(current.messages);
          input.onUpdate?.(current);
        }
        if (event.type === "tool_result_end" && event.message) {
          current.messages.push(event.message as Message);
          input.onUpdate?.(current);
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => { current.stderr += data.toString(); });
      proc.on("close", (code) => { if (buffer.trim()) processLine(buffer); resolve(code ?? 0); });
      proc.on("error", () => resolve(1));
      if (input.signal) {
        const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
        if (input.signal.aborted) kill(); else input.signal.addEventListener("abort", kill, { once: true });
      }
    });

    current.exitCode = exitCode;
    current.output = getFinalOutput(current.messages) || current.errorMessage || current.stderr || "";
    await writeAgentArtifact(input.ledger, { phaseId: input.task.phaseId, agent: agent.name, kind: "output", content: current.output || "(no output)" });
    await appendLedgerEvent(input.ledger, { type: exitCode === 0 ? "agent_succeeded" : "agent_failed", phaseId: input.task.phaseId, agent: agent.name, message: `exit ${exitCode}` });
    return current;
  } finally {
    if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch {}
    if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch {}
  }
}

export async function runMuonAgentsParallel(input: Omit<RunAgentInput, "task"> & { tasks: MuonAgentTask[]; maxParallel: number }): Promise<MuonAgentResult[]> {
  const limit = Math.max(1, Math.min(input.maxParallel, input.tasks.length));
  const results: MuonAgentResult[] = new Array(input.tasks.length);
  let next = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const index = next++;
      if (index >= input.tasks.length) return;
      results[index] = await runSingleMuonAgent({ ...input, task: input.tasks[index] });
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runMuonAgentChain(input: Omit<RunAgentInput, "task"> & { chain: MuonAgentTask[] }): Promise<MuonAgentResult[]> {
  const results: MuonAgentResult[] = [];
  let previous = "";
  for (const step of input.chain) {
    const task = { ...step, task: step.task.replace(/\{previous\}/g, previous) };
    const result = await runSingleMuonAgent({ ...input, task });
    results.push(result);
    if (result.exitCode !== 0) return results;
    previous = result.output;
  }
  return results;
}
