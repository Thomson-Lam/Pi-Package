import { z } from "zod";

const riskEnum = z.enum(["low", "medium", "high"]);
const detailEnum = z.enum(["ultralow", "low", "medium", "high"]);
const confidenceEnum = z.enum(["low", "medium", "high"]);

const snippetId = z.string().min(1);
const pathString = z.string().min(1);

export const StatusSchema = z
  .object({
    currentState: z.string().min(1),
    reviewScope: z.string().min(1),
    changeSummary: z.string().min(1).optional(),
    confidence: confidenceEnum.optional(),
  })
  .strict();

export const FileMapEntrySchema = z
  .object({
    path: pathString,
    role: z.string().min(1),
    whyRelevant: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    changed: z.boolean().optional(),
    responsibilities: z.array(z.string().min(1)).optional(),
    interactsWith: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const BuildingBlockSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["component", "module", "function", "class", "route", "schema", "config", "test", "workflow", "data", "other"]),
    description: z.string().min(1),
    files: z.array(pathString).min(1),
    responsibilities: z.array(z.string().min(1)).optional(),
    inputs: z.array(z.string().min(1)).optional(),
    outputs: z.array(z.string().min(1)).optional(),
    dependencies: z.array(z.string().min(1)).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const WorkflowStepSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
    files: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const WorkflowSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1),
    trigger: z.string().min(1).optional(),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict();

export const FlowNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["input", "process", "decision", "storage", "output", "external", "other"]).optional(),
    description: z.string().min(1).optional(),
    files: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const FlowEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict();

export const DataFlowSchema = z
  .object({
    name: z.string().min(1),
    summary: z.string().min(1).optional(),
    nodes: z.array(FlowNodeSchema).min(2),
    edges: z.array(FlowEdgeSchema).min(1),
  })
  .strict();

export const SnippetRefSchema = z
  .object({
    id: snippetId,
    path: pathString,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    caption: z.string().min(1),
    source: z.enum(["worktree", "index", "head", "base"]).optional(),
    highlights: z.array(z.number().int().positive()).optional(),
    mustContain: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, { message: "endLine must be greater than or equal to startLine" });

export const ReviewFocusSchema = z
  .object({
    area: z.string().min(1),
    question: z.string().min(1),
    severity: riskEnum.optional(),
    files: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const RiskCalloutSchema = z
  .object({
    severity: riskEnum,
    area: z.string().optional(),
    description: z.string().min(1),
    mitigation: z.string().optional(),
    files: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const DecisionSchema = z
  .object({
    decision: z.string().min(1),
    rationale: z.string().optional(),
    alternatives: z.array(z.string().min(1)).optional(),
    files: z.array(pathString).optional(),
    snippetIds: z.array(snippetId).optional(),
  })
  .strict();

export const RelevantTestSchema = z
  .object({
    name: z.string().min(1),
    file: pathString.optional(),
    line: z.number().int().positive().optional(),
    description: z.string().min(1),
    relatedFiles: z.array(pathString).optional(),
  })
  .strict();

export const ValidationRunSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().optional(),
    result: z.enum(["passed", "failed", "skipped", "not_run", "partial"]),
    evidence: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const ValidationSchema = z
  .object({
    relevantTests: z.array(RelevantTestSchema).optional(),
    runs: z.array(ValidationRunSchema).optional(),
  })
  .strict();

export const ReviewReportSchema = z
  .object({
    schemaVersion: z.literal("2.0"),
    artifactKind: z.literal("codebase-review"),
    title: z.string().min(1),
    reviewDetail: detailEnum.optional(),
    status: StatusSchema,
    fileMap: z.array(FileMapEntrySchema).min(1),
    buildingBlocks: z.array(BuildingBlockSchema).optional(),
    workflows: z.array(WorkflowSchema).optional(),
    dataFlows: z.array(DataFlowSchema).optional(),
    snippets: z.array(SnippetRefSchema).optional(),
    reviewFocus: z.array(ReviewFocusSchema).optional(),
    risks: z.array(RiskCalloutSchema).optional(),
    decisions: z.array(DecisionSchema).optional(),
    validation: ValidationSchema.optional(),
    knownLimitations: z.array(z.string().min(1)).optional(),
    missingValidation: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type ReviewDetail = z.infer<typeof detailEnum>;
export type SnippetRef = z.infer<typeof SnippetRefSchema>;
export type FileMapEntry = z.infer<typeof FileMapEntrySchema>;
export type BuildingBlock = z.infer<typeof BuildingBlockSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type DataFlow = z.infer<typeof DataFlowSchema>;

export function validateReport(input: unknown): ReviewReport {
  return ReviewReportSchema.parse(input);
}

export function reportJsonSchema(): unknown {
  const zAny = z as unknown as { toJSONSchema?: (schema: unknown) => unknown };
  if (!zAny.toJSONSchema) {
    throw new Error("Installed zod version does not expose z.toJSONSchema; upgrade to Zod 4.");
  }
  return zAny.toJSONSchema(ReviewReportSchema);
}
