import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { MUON_RUNS_DIR } from "./constants.js";

export interface RunLedger {
  runId: string;
  name: string;
  runDir: string;
  ledgerPath: string;
  eventsPath: string;
  workflowPath: string;
  startedAt: number;
}

export interface CreateRunLedgerInput {
  runId: string;
  name: string;
  workflow?: unknown;
}

export interface LedgerEvent {
  type: string;
  message: string;
  phaseId?: string;
  agent?: string;
  timestamp?: number;
  details?: unknown;
}

export async function createRunLedger(input: CreateRunLedgerInput): Promise<RunLedger> {
  const startedAt = Date.now();
  const safeName = input.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  const runDir = join(MUON_RUNS_DIR, `${startedAt}-${safeName}-${input.runId}`);
  await mkdir(runDir, { recursive: true });

  const ledger: RunLedger = {
    runId: input.runId,
    name: input.name,
    runDir,
    ledgerPath: join(runDir, "ledger.md"),
    eventsPath: join(runDir, "events.jsonl"),
    workflowPath: join(runDir, "workflow.json"),
    startedAt,
  };

  await writeFile(ledger.workflowPath, JSON.stringify(input.workflow ?? null, null, 2) + "\n", "utf8");
  await writeFile(ledger.eventsPath, "", "utf8");
  await writeFile(ledger.ledgerPath, `# Muon Run: ${input.name}\n\n- Run ID: ${input.runId}\n- Started: ${new Date(startedAt).toISOString()}\n- Status: running\n\n## Events\n`, "utf8");
  await appendLedgerEvent(ledger, { type: "run_started", message: `Run started: ${input.name}` });
  return ledger;
}

export async function appendLedgerEvent(ledger: RunLedger, event: LedgerEvent): Promise<void> {
  const timestamp = event.timestamp ?? Date.now();
  const fullEvent = { ...event, timestamp };
  await appendFile(ledger.eventsPath, JSON.stringify(fullEvent) + "\n", "utf8");
  const scope = [event.phaseId, event.agent].filter(Boolean).join("/");
  const prefix = scope ? `**${scope}** ` : "";
  await appendFile(ledger.ledgerPath, `- ${new Date(timestamp).toISOString()} ${prefix}${event.type}: ${event.message}\n`, "utf8");
}

export async function writeAgentArtifact(
  ledger: RunLedger,
  artifact: { phaseId?: string; agent: string; kind: "prompt" | "output" | "stderr" | "summary"; content: string },
): Promise<string> {
  const safePhase = (artifact.phaseId ?? "run").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeAgent = artifact.agent.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const filePath = join(ledger.runDir, `${safePhase}-${safeAgent}-${artifact.kind}.md`);
  await writeFile(filePath, artifact.content, "utf8");
  await appendLedgerEvent(ledger, { type: `${artifact.kind}_written`, phaseId: artifact.phaseId, agent: artifact.agent, message: filePath });
  return filePath;
}

export async function completeRunLedger(ledger: RunLedger, status: "succeeded" | "failed" | "aborted"): Promise<void> {
  await appendLedgerEvent(ledger, { type: "run_completed", message: `Run completed with status: ${status}` });
  await appendFile(ledger.ledgerPath, `\n## Final Status\n\n${status}\n`, "utf8");
}
