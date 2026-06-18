import { z } from "zod";

const riskEnum = z.enum(["low", "medium", "high"]);
const detailEnum = z.enum(["ultralow", "low", "medium", "high"]);

export const ReviewSummarySchema = z
  .object({
    intent: z.string().min(1),
    changeType: z.enum(["feature", "bugfix", "refactor", "test", "docs", "chore", "mixed"]).optional(),
    howItWorks: z.string().max(800).optional(),
  })
  .strict();

export const ChangeFileSchema = z
  .object({
    path: z.string().min(1),
    purpose: z.string().min(1),
    risk: riskEnum.optional(),
  })
  .strict();

export const ChangeGroupSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    files: z.array(ChangeFileSchema).min(1),
    reviewerNotes: z.array(z.string().min(1)).optional(),
    risk: riskEnum.optional(),
  })
  .strict();

export const ChapterFileSchema = z
  .object({
    path: z.string().min(1),
    purpose: z.string().optional(),
    reviewFocus: z.array(z.string().min(1)).optional(),
    risk: riskEnum.optional(),
  })
  .strict();

export const ChapterSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    sequence: z.number().int().positive().optional(),
    intent: z.string().optional(),
    files: z.array(ChapterFileSchema).min(1),
    reviewFocus: z.array(z.string().min(1)).optional(),
    risks: z.array(z.string().min(1)).optional(),
    validation: z.array(z.string().min(1)).optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const BehaviorStepSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const RiskCalloutSchema = z
  .object({
    severity: riskEnum,
    area: z.string().optional(),
    description: z.string().min(1),
    mitigation: z.string().optional(),
    files: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const DecisionSchema = z
  .object({
    decision: z.string().min(1),
    rationale: z.string().optional(),
    alternatives: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const RelevantTestSchema = z
  .object({
    name: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    description: z.string().min(1),
    relatedFiles: z.array(z.string().min(1)).optional(),
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
    schemaVersion: z.literal("1.0"),
    title: z.string().min(1),
    reviewDetail: detailEnum.optional(),
    summary: ReviewSummarySchema,
    changes: z.array(ChangeGroupSchema).min(1),
    chapters: z.array(ChapterSchema).optional(),
    behaviorFlow: z.array(BehaviorStepSchema).optional(),
    risks: z.array(RiskCalloutSchema).optional(),
    decisions: z.array(DecisionSchema).optional(),
    validation: ValidationSchema.optional(),
    knownLimitations: z.array(z.string().min(1)).optional(),
    missingValidation: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ReviewReport = z.infer<typeof ReviewReportSchema>;
export type ReviewChapter = z.infer<typeof ChapterSchema>;
export type ReviewChapterFile = z.infer<typeof ChapterFileSchema>;
export type ReviewDetail = z.infer<typeof detailEnum>;

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
