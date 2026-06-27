import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_PARALLEL_HARD_CAP } from "./constants.js";
import { discoverMuonAgents } from "./agents.js";
import { createRunLedger, completeRunLedger } from "./ledger.js";
import { runMuonAgentChain, runMuonAgentsParallel, runSingleMuonAgent } from "./runner.js";
import type { AgentScope, MuonState } from "./types.js";
import { renderMuonSubagentResult } from "./render.js";

export interface MuonToolDeps {
  getState: () => MuonState;
  setState: (updater: (draft: MuonState) => void, ctx: ExtensionContext) => void;
}

const TaskItem = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, { default: "user" });

const MuonSubagentParams = Type.Object({
  name: Type.Optional(Type.String({ description: "Human-readable run name" })),
  agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
  task: Type.Optional(Type.String({ description: "Task for single mode" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential chain; {previous} is replaced with prior output" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
  maxParallel: Type.Optional(Type.Number({ default: 2 })),
  maxDepth: Type.Optional(Type.Number({ default: 1 })),
});

const WorkflowPhase = Type.Object({
  id: Type.String(),
  title: Type.String(),
  kind: StringEnum(["single", "parallel", "chain"] as const),
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(TaskItem)),
  chain: Type.Optional(Type.Array(TaskItem)),
});

const MuonWorkflowParams = Type.Object({
  name: Type.String(),
  objective: Type.String(),
  phases: Type.Array(WorkflowPhase),
  agentScope: Type.Optional(AgentScopeSchema),
  maxParallel: Type.Optional(Type.Number({ default: 2 })),
  maxDepth: Type.Optional(Type.Number({ default: 1 })),
});

function runId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function currentDepth(): number {
  const raw = process.env.MUON_DEPTH;
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function registerMuonTools(pi: ExtensionAPI, deps: MuonToolDeps): void {
  pi.registerTool({
    name: "muon_subagent",
    label: "Muon Subagent",
    description: "Run transparent Muon subagents in single, parallel, or chain mode with durable ledger output.",
    parameters: MuonSubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = deps.getState();
      const agentScope = (params.agentScope ?? state.config.defaultAgentScope) as AgentScope;
      const maxParallel = Math.max(1, Math.min(params.maxParallel ?? state.config.maxParallel, MAX_PARALLEL_HARD_CAP));
      const maxDepth = params.maxDepth ?? state.config.maxDepth;
      const depth = currentDepth();
      if (depth >= maxDepth) throw new Error(`Muon maxDepth reached: depth ${depth}, maxDepth ${maxDepth}`);

      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      const hasChain = Boolean(params.chain?.length);
      if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
        throw new Error("Provide exactly one mode: agent+task, tasks, or chain");
      }

      const discovery = discoverMuonAgents(ctx.cwd, agentScope);
      if ((agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
        const ok = await ctx.ui.confirm("Run project-local Muon agents?", `Project agent dir: ${discovery.projectAgentsDir ?? "none"}`);
        if (!ok) return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: { canceled: true } };
      }

      const id = runId();
      const name = params.name ?? (hasSingle ? `subagent-${params.agent}` : hasParallel ? "subagent-parallel" : "subagent-chain");
      const ledger = await createRunLedger({ runId: id, name, workflow: params });
      deps.setState((draft) => {
        draft.activeRunId = id;
        draft.runs[id] = { runId: id, name, status: "running", startedAt: ledger.startedAt, updatedAt: Date.now(), runDir: ledger.runDir, ledgerPath: ledger.ledgerPath, workflowPath: ledger.workflowPath };
      }, ctx);

      const update = (summary: string) => {
        onUpdate?.({ content: [{ type: "text", text: summary }], details: { runId: id, runDir: ledger.runDir, ledgerPath: ledger.ledgerPath } });
      };

      try {
        let results;
        if (hasSingle) {
          results = [await runSingleMuonAgent({ defaultCwd: ctx.cwd, agents: discovery.agents, ledger, depth, maxDepth, signal, task: { agent: params.agent!, task: params.task! }, onUpdate: (r) => update(`${r.agent}: ${r.output.slice(0, 500) || "running"}`) })];
        } else if (hasParallel) {
          results = await runMuonAgentsParallel({ defaultCwd: ctx.cwd, agents: discovery.agents, ledger, depth, maxDepth, signal, tasks: params.tasks!, maxParallel, onUpdate: (r) => update(`${r.agent}: ${r.output.slice(0, 500) || "running"}`) });
        } else {
          results = await runMuonAgentChain({ defaultCwd: ctx.cwd, agents: discovery.agents, ledger, depth, maxDepth, signal, chain: params.chain!, onUpdate: (r) => update(`${r.agent}: ${r.output.slice(0, 500) || "running"}`) });
        }

        const failed = results.some((r) => r.exitCode !== 0);
        const status = failed ? "failed" : "succeeded";
        await completeRunLedger(ledger, status);
        deps.setState((draft) => { draft.runs[id].status = status; draft.runs[id].updatedAt = Date.now(); }, ctx);
        const summary = results.map((r) => `### ${r.agent} (${r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`})\n\n${r.output || r.stderr || "(no output)"}`).join("\n\n---\n\n");
        return { content: [{ type: "text", text: `Muon run ${id} ${status}\nLedger: ${ledger.ledgerPath}\n\n${summary}` }], details: { runId: id, runDir: ledger.runDir, ledgerPath: ledger.ledgerPath, results } };
      } catch (error) {
        await completeRunLedger(ledger, "failed");
        deps.setState((draft) => { draft.runs[id].status = "failed"; draft.runs[id].updatedAt = Date.now(); }, ctx);
        throw error;
      }
    },
    renderResult: renderMuonSubagentResult as any,
  });

  pi.registerTool({
    name: "muon_workflow",
    label: "Muon Workflow",
    description: "Run a declarative multi-phase Muon workflow. The main agent should use this instead of manually orchestrating many subagent calls.",
    parameters: MuonWorkflowParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { runMuonWorkflow } = await import("./workflow.js");
      const state = deps.getState();
      const agentScope = (params.agentScope ?? state.config.defaultAgentScope) as AgentScope;
      const maxParallel = Math.max(1, Math.min(params.maxParallel ?? state.config.maxParallel, MAX_PARALLEL_HARD_CAP));
      const maxDepth = params.maxDepth ?? state.config.maxDepth;
      const depth = currentDepth();
      if (depth >= maxDepth) throw new Error(`Muon maxDepth reached: depth ${depth}, maxDepth ${maxDepth}`);

      const discovery = discoverMuonAgents(ctx.cwd, agentScope);
      const id = runId();
      const ledger = await createRunLedger({ runId: id, name: params.name, workflow: params });
      deps.setState((draft) => {
        draft.activeRunId = id;
        draft.runs[id] = { runId: id, name: params.name, status: "running", startedAt: ledger.startedAt, updatedAt: Date.now(), runDir: ledger.runDir, ledgerPath: ledger.ledgerPath, workflowPath: ledger.workflowPath };
      }, ctx);

      const result = await runMuonWorkflow({
        defaultCwd: ctx.cwd,
        agents: discovery.agents,
        ledger,
        phases: params.phases as any,
        depth,
        maxDepth,
        maxParallel,
        signal,
        onPhaseUpdate: (phase, results) => onUpdate?.({ content: [{ type: "text", text: `Phase ${phase.id} complete: ${results.length} result(s)` }], details: { runId: id, phaseId: phase.id, ledgerPath: ledger.ledgerPath } }),
      });

      const status = result.failed ? "failed" : "succeeded";
      await completeRunLedger(ledger, status);
      deps.setState((draft) => { draft.runs[id].status = status; draft.runs[id].updatedAt = Date.now(); }, ctx);
      const summary = result.phaseResults.map((p) => `## ${p.phase.id}: ${p.phase.title}\n${p.results.map((r) => `- ${r.agent}: ${r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`} (${r.output.slice(0, 160).replace(/\n/g, " ")})`).join("\n")}`).join("\n\n");
      return { content: [{ type: "text", text: `Muon workflow ${id} ${status}\nLedger: ${ledger.ledgerPath}\n\n${summary}` }], details: { runId: id, runDir: ledger.runDir, ledgerPath: ledger.ledgerPath, result } };
    },
    renderResult: renderMuonSubagentResult as any,
  });
}
