import type { GitSnapshot } from "./git.js";
import type { ReviewDetail, ReviewReport } from "./schema.js";

export type DetailCheckStatus = "pass" | "warn" | "fail";

export type DetailCheck = {
  id: string;
  label: string;
  status: DetailCheckStatus;
  detail: string;
};

export type DetailProfileResult = {
  detail: ReviewDetail;
  requestedDetail?: ReviewDetail;
  enforced: boolean;
  checks: DetailCheck[];
  errors: string[];
  warnings: string[];
  coverage?: {
    changedFiles: number;
    mappedChangedFiles: number;
    missingFiles: string[];
    staleChangedFlags: string[];
  };
};

const snippetBudgets: Record<ReviewDetail, { maxCount: number; maxLines: number; minCount: number }> = {
  ultralow: { minCount: 0, maxCount: 3, maxLines: 80 },
  low: { minCount: 1, maxCount: 6, maxLines: 180 },
  medium: { minCount: 2, maxCount: 12, maxLines: 400 },
  high: { minCount: 4, maxCount: 25, maxLines: 900 },
};

export function analyzeDetailProfile(opts: {
  report: ReviewReport;
  git?: GitSnapshot;
  requestedDetail?: ReviewDetail;
}): DetailProfileResult {
  const { report, git, requestedDetail } = opts;
  const detail = requestedDetail || report.reviewDetail || "medium";
  const enforced = Boolean(requestedDetail || report.reviewDetail);
  const checks: DetailCheck[] = [];
  const coverage = git ? fileMapCoverage(report, git) : undefined;

  addDetailMetadataCheck(checks, report, requestedDetail);
  addStatusCheck(checks, detail, report);
  addFileMapCheck(checks, detail, report, coverage, Boolean(git));
  addSnippetChecks(checks, detail, report);
  addStructureChecks(checks, detail, report);
  addValidationCheck(checks, detail, report);
  addRiskDecisionLimitationChecks(checks, detail, report);

  const errors = checks.filter((check) => check.status === "fail").map((check) => `${check.label}: ${check.detail}`);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => `${check.label}: ${check.detail}`);
  return { detail, requestedDetail, enforced, checks, errors, warnings, coverage };
}

export function parseReviewDetail(value: string | undefined): ReviewDetail | undefined {
  if (value === undefined) return undefined;
  if (value === "ultralow" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Unsupported --detail ${JSON.stringify(value)}. Use ultralow, low, medium, or high.`);
}

function addDetailMetadataCheck(checks: DetailCheck[], report: ReviewReport, requestedDetail?: ReviewDetail): void {
  if (!requestedDetail) {
    checks.push({
      id: "detail-metadata",
      label: "Detail metadata",
      status: report.reviewDetail ? "pass" : "warn",
      detail: report.reviewDetail ? `Report declares ${report.reviewDetail} detail.` : "Report has no reviewDetail; using default medium semantics unless --detail is passed.",
    });
    return;
  }
  checks.push({
    id: "detail-metadata",
    label: "Detail metadata",
    status: report.reviewDetail === requestedDetail ? "pass" : "fail",
    detail: report.reviewDetail === requestedDetail ? `Report detail matches requested ${requestedDetail}.` : `Validation requested ${requestedDetail}, but report.reviewDetail is ${report.reviewDetail || "missing"}.`,
  });
}

function addStatusCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const hasChangeSummary = Boolean(report.status.changeSummary?.trim());
  checks.push({
    id: "status",
    label: "Current status",
    status: detail === "ultralow" || hasChangeSummary ? "pass" : "warn",
    detail: hasChangeSummary ? "Current state, review scope, and change summary are documented." : "Current state and scope are present; changeSummary is optional for ultralow but useful for richer tiers.",
  });
}

function addFileMapCheck(
  checks: DetailCheck[],
  detail: ReviewDetail,
  report: ReviewReport,
  coverage: DetailProfileResult["coverage"],
  diffAware: boolean,
): void {
  const missingRole = report.fileMap.filter((entry) => !entry.role.trim()).map((entry) => entry.path);
  checks.push({
    id: "file-map-role",
    label: "File map roles",
    status: missingRole.length ? "fail" : "pass",
    detail: missingRole.length ? `Missing role for ${sampleList(missingRole)}.` : `${report.fileMap.length} file-map entr${report.fileMap.length === 1 ? "y" : "ies"} include roles.`,
  });

  if (!diffAware || !coverage) {
    checks.push({
      id: "file-map-coverage",
      label: "Changed-file coverage",
      status: detail === "ultralow" || detail === "low" ? "pass" : "warn",
      detail: detail === "ultralow" || detail === "low" ? `${labelDetail(detail)} can validate without git metadata.` : "Pass --cwd/--mode to validate changed-file coverage for medium/high detail.",
    });
    return;
  }

  const failures = [
    ...(coverage.missingFiles.length ? [`missing changed files: ${sampleList(coverage.missingFiles)}`] : []),
    ...(coverage.staleChangedFlags.length ? [`changed=true but not in diff: ${sampleList(coverage.staleChangedFlags)}`] : []),
  ];
  const required = detail === "medium" || detail === "high";
  checks.push({
    id: "file-map-coverage",
    label: "Changed-file coverage",
    status: failures.length ? (required ? "fail" : "warn") : "pass",
    detail: failures.length ? failures.join("; ") : `${coverage.mappedChangedFiles}/${coverage.changedFiles} changed file(s) represented in fileMap.`,
  });
}

function addSnippetChecks(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const snippets = report.snippets || [];
  const ids = snippets.map((snippet) => snippet.id);
  const duplicateIds = duplicates(ids);
  const referenced = collectSnippetRefs(report);
  const missingRefs = Array.from(referenced).filter((id) => !ids.includes(id));
  const totalLines = snippets.reduce((sum, snippet) => sum + Math.max(0, snippet.endLine - snippet.startLine + 1), 0);
  const budget = snippetBudgets[detail];

  checks.push({
    id: "snippet-ids",
    label: "Snippet references",
    status: duplicateIds.length || missingRefs.length ? "fail" : "pass",
    detail: duplicateIds.length || missingRefs.length ? `Duplicate ids: ${sampleList(duplicateIds)}; unresolved refs: ${sampleList(missingRefs)}.` : `${snippets.length} snippet definition(s), ${referenced.size} reference(s), all resolved.`,
  });

  const budgetFailures = [
    snippets.length < budget.minCount ? `expected at least ${budget.minCount} snippet(s)` : undefined,
    snippets.length > budget.maxCount ? `${snippets.length} snippets exceeds ${budget.maxCount}` : undefined,
    totalLines > budget.maxLines ? `${totalLines} snippet lines exceeds ${budget.maxLines}` : undefined,
  ].filter(Boolean) as string[];
  checks.push({
    id: "snippet-budget",
    label: "Snippet budget",
    status: budgetFailures.length ? (detail === "ultralow" ? "warn" : "fail") : "pass",
    detail: budgetFailures.length ? budgetFailures.join("; ") : `${snippets.length} snippet(s), ${totalLines}/${budget.maxLines} referenced line(s).`,
  });
}

function addStructureChecks(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const blocks = report.buildingBlocks?.length || 0;
  const workflows = report.workflows?.length || 0;
  const dataFlows = report.dataFlows?.length || 0;
  if (detail === "ultralow") {
    checks.push({ id: "structure", label: "Understanding structure", status: blocks || workflows || dataFlows ? "pass" : "warn", detail: blocks || workflows || dataFlows ? "At least one explanatory section is present." : "Ultralow permits only status + file map, but one workflow/block is helpful." });
    return;
  }
  if (detail === "low") {
    checks.push({ id: "structure", label: "Understanding structure", status: blocks + workflows + dataFlows >= 1 ? "pass" : "fail", detail: blocks + workflows + dataFlows >= 1 ? `${blocks} block(s), ${workflows} workflow(s), ${dataFlows} data flow(s).` : "Low detail requires at least one building block, workflow, or data flow." });
    return;
  }
  const hasWorkflow = workflows + dataFlows >= 1;
  const hasBlocks = blocks >= 1;
  checks.push({
    id: "structure",
    label: "Understanding structure",
    status: hasWorkflow && hasBlocks ? "pass" : "fail",
    detail: hasWorkflow && hasBlocks ? `${blocks} building block(s), ${workflows} workflow(s), ${dataFlows} data flow(s).` : "Medium/high detail require buildingBlocks and at least one workflow or dataFlow.",
  });
}

function addValidationCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const runs = report.validation?.runs || [];
  const hasMissingValidation = hasOwn(report, "missingValidation");
  const missingValidationCount = report.missingValidation?.length || 0;
  if (detail === "ultralow") {
    checks.push({ id: "validation", label: "Validation documentation", status: runs.length || missingValidationCount ? "pass" : "warn", detail: runs.length || missingValidationCount ? `${runs.length} run(s), ${missingValidationCount} missing-validation note(s).` : "Ultralow permits omitted validation documentation for speed." });
    return;
  }
  if (detail === "low") {
    checks.push({ id: "validation", label: "Validation documentation", status: runs.length || missingValidationCount ? "pass" : "fail", detail: runs.length || missingValidationCount ? `${runs.length} run(s), ${missingValidationCount} missing-validation note(s).` : "Low detail requires at least one validation run or missingValidation note." });
    return;
  }
  checks.push({
    id: "validation",
    label: "Validation documentation",
    status: report.validation && hasMissingValidation ? "pass" : "fail",
    detail: report.validation && hasMissingValidation ? `${runs.length} validation run(s); missingValidation field is present.` : "Medium/high detail require validation and missingValidation fields, even if missingValidation is empty.",
  });
}

function addRiskDecisionLimitationChecks(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  if (detail !== "high") {
    checks.push({ id: "risk-decision-limitation", label: "Risks, decisions, limitations", status: "pass", detail: `${labelDetail(detail)} records these when relevant.` });
    return;
  }
  const failures = [
    ...(report.reviewFocus?.length ? [] : ["reviewFocus"]),
    ...(report.risks?.length ? [] : ["risks or explicit low-risk callout"]),
    ...(report.decisions?.length ? [] : ["decisions or explicit no-notable-decisions entry"]),
    ...(report.knownLimitations?.length ? [] : ["knownLimitations or explicit none entry"]),
  ];
  checks.push({
    id: "risk-decision-limitation",
    label: "Risks, decisions, limitations",
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? `High detail requires: ${sampleList(failures)}.` : "High-detail review focus, risks, decisions, and limitations are documented.",
  });
}

function fileMapCoverage(report: ReviewReport, git: GitSnapshot): DetailProfileResult["coverage"] {
  const changed = new Set(git.files.map((file) => file.path));
  const mappedChanged = new Set(report.fileMap.filter((entry) => entry.changed !== false).map((entry) => entry.path));
  return {
    changedFiles: changed.size,
    mappedChangedFiles: Array.from(mappedChanged).filter((path) => changed.has(path)).length,
    missingFiles: Array.from(changed).filter((path) => !mappedChanged.has(path)),
    staleChangedFlags: Array.from(mappedChanged).filter((path) => !changed.has(path)),
  };
}

function collectSnippetRefs(report: ReviewReport): Set<string> {
  const ids = new Set<string>();
  const add = (values?: string[]) => values?.forEach((id) => ids.add(id));
  report.fileMap.forEach((entry) => add(entry.snippetIds));
  report.buildingBlocks?.forEach((entry) => add(entry.snippetIds));
  report.workflows?.forEach((workflow) => workflow.steps.forEach((step) => add(step.snippetIds)));
  report.dataFlows?.forEach((flow) => flow.nodes.forEach((node) => add(node.snippetIds)));
  report.reviewFocus?.forEach((entry) => add(entry.snippetIds));
  report.risks?.forEach((entry) => add(entry.snippetIds));
  report.decisions?.forEach((entry) => add(entry.snippetIds));
  return ids;
}

function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries()).filter(([, count]) => count > 1).map(([value]) => value);
}

function labelDetail(detail: ReviewDetail): string {
  return detail === "ultralow" ? "Ultralow detail" : detail === "low" ? "Low detail" : detail === "medium" ? "Medium detail" : "High detail";
}

function sampleList(values: string[], max = 8): string {
  if (values.length === 0) return "none";
  const sample = values.slice(0, max).join(", ");
  return values.length > max ? `${sample}, … (${values.length - max} more)` : sample;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
