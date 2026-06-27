import type { AgentConfig } from "./agents.js";
import type { RunLedger } from "./ledger.js";
import { appendLedgerEvent } from "./ledger.js";
import { runMuonAgentChain, runMuonAgentsParallel, runSingleMuonAgent, type MuonAgentResult, type MuonAgentTask } from "./runner.js";
import type { WorkflowPhaseKind } from "./types.js";

export interface MuonWorkflowPhase {
  id: string;
  title: string;
  kind: WorkflowPhaseKind;
  agent?: string;
  task?: string;
  tasks?: MuonAgentTask[];
  chain?: MuonAgentTask[];
}

export interface RunMuonWorkflowInput {
  defaultCwd: string;
  agents: AgentConfig[];
  ledger: RunLedger;
  phases: MuonWorkflowPhase[];
  depth: number;
  maxDepth: number;
  maxParallel: number;
  signal?: AbortSignal;
  onPhaseUpdate?: (phase: MuonWorkflowPhase, results: MuonAgentResult[]) => void;
}

export interface MuonWorkflowResult {
  phaseResults: Array<{ phase: MuonWorkflowPhase; results: MuonAgentResult[] }>;
  failed: boolean;
}

export async function runMuonWorkflow(input: RunMuonWorkflowInput): Promise<MuonWorkflowResult> {
  const phaseResults: Array<{ phase: MuonWorkflowPhase; results: MuonAgentResult[] }> = [];
  for (const phase of input.phases) {
    await appendLedgerEvent(input.ledger, { type: "phase_started", phaseId: phase.id, message: phase.title });
    let results: MuonAgentResult[];

    if (phase.kind === "single") {
      if (!phase.agent || !phase.task) throw new Error(`Phase ${phase.id} single requires agent and task`);
      results = [await runSingleMuonAgent({ defaultCwd: input.defaultCwd, agents: input.agents, ledger: input.ledger, depth: input.depth, maxDepth: input.maxDepth, signal: input.signal, task: { agent: phase.agent, task: phase.task, phaseId: phase.id } })];
    } else if (phase.kind === "parallel") {
      if (!phase.tasks?.length) throw new Error(`Phase ${phase.id} parallel requires tasks`);
      results = await runMuonAgentsParallel({ defaultCwd: input.defaultCwd, agents: input.agents, ledger: input.ledger, depth: input.depth, maxDepth: input.maxDepth, signal: input.signal, tasks: phase.tasks.map((t) => ({ ...t, phaseId: phase.id })), maxParallel: input.maxParallel });
    } else {
      if (!phase.chain?.length) throw new Error(`Phase ${phase.id} chain requires chain`);
      results = await runMuonAgentChain({ defaultCwd: input.defaultCwd, agents: input.agents, ledger: input.ledger, depth: input.depth, maxDepth: input.maxDepth, signal: input.signal, chain: phase.chain.map((t) => ({ ...t, phaseId: phase.id })) });
    }

    phaseResults.push({ phase, results });
    input.onPhaseUpdate?.(phase, results);
    const failed = results.some((r) => r.exitCode !== 0);
    await appendLedgerEvent(input.ledger, { type: failed ? "phase_failed" : "phase_succeeded", phaseId: phase.id, message: phase.title });
    if (failed) return { phaseResults, failed: true };
  }
  return { phaseResults, failed: false };
}
