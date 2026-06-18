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
    assignedFiles: number;
    missingFiles: string[];
    staleFiles: string[];
    duplicateFiles: string[];
  };
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

  const chapters = report.chapters || [];
  const chapterFilePaths = chapters.flatMap((chapter) => chapter.files.map((file) => file.path));
  const chapterPathCounts = countValues(chapterFilePaths);
  const duplicateFiles = Array.from(chapterPathCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([path]) => path);

  const coverage = git ? diffCoverage(git, chapterFilePaths) : undefined;

  addDetailMetadataCheck(checks, report, requestedDetail);
  addChapterStructureCheck(checks, detail, chapters.length);
  addFileContextCheck(checks, detail, report);
  addReviewFocusCheck(checks, detail, report);
  addValidationCheck(checks, detail, report);
  addRiskDecisionLimitationChecks(checks, detail, report);
  addBehaviorFlowCheck(checks, detail, report);
  addDiffCoverageChecks(checks, detail, coverage, duplicateFiles, Boolean(git));

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
      detail: report.reviewDetail ? `Report declares ${report.reviewDetail} detail.` : "Report has no reviewDetail; using default medium semantics without enforcement unless --detail is passed.",
    });
    return;
  }
  if (!report.reviewDetail) {
    checks.push({
      id: "detail-metadata",
      label: "Detail metadata",
      status: "fail",
      detail: `Validation requested ${requestedDetail} detail, but report.reviewDetail is missing. Set reviewDetail to "${requestedDetail}".`,
    });
    return;
  }
  checks.push({
    id: "detail-metadata",
    label: "Detail metadata",
    status: report.reviewDetail === requestedDetail ? "pass" : "fail",
    detail:
      report.reviewDetail === requestedDetail
        ? `Report detail matches requested ${requestedDetail}.`
        : `Validation requested ${requestedDetail}, but report.reviewDetail is ${report.reviewDetail}.`,
  });
}

function addChapterStructureCheck(checks: DetailCheck[], detail: ReviewDetail, chapterCount: number): void {
  if (detail === "ultralow" || detail === "low") {
    const preferredMax = detail === "ultralow" ? 1 : 3;
    checks.push({
      id: "chapter-structure",
      label: "Chapter structure",
      status: chapterCount === 0 || chapterCount <= preferredMax ? "pass" : "warn",
      detail: chapterCount === 0 ? `${labelDetail(detail)} may derive chapters from changes.` : `${chapterCount} explicit chapter(s); ${detail} detail prefers 1-${preferredMax}.`,
    });
    return;
  }
  if (chapterCount === 0) {
    checks.push({ id: "chapter-structure", label: "Chapter structure", status: "fail", detail: `${detail} detail requires explicit chapters.` });
    return;
  }
  if (detail === "medium") {
    checks.push({
      id: "chapter-structure",
      label: "Chapter structure",
      status: chapterCount <= 8 ? "pass" : "warn",
      detail: `${chapterCount} explicit chapter(s); medium detail usually works best with 3-6.`,
    });
    return;
  }
  checks.push({
    id: "chapter-structure",
    label: "Chapter structure",
    status: "pass",
    detail: `${chapterCount} explicit chapter(s) present for high-detail review.`,
  });
}

function addFileContextCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const targetFiles = (report.chapters?.length ? report.chapters.flatMap((chapter) => chapter.files) : report.changes.flatMap((change) => change.files)) || [];
  const missingPurpose = targetFiles.filter((file) => !file.purpose?.trim()).map((file) => file.path);
  checks.push({
    id: "file-context",
    label: "File context",
    status: missingPurpose.length ? "fail" : "pass",
    detail: missingPurpose.length ? `Missing purpose for ${sampleList(missingPurpose)}.` : `${targetFiles.length} file reference(s) include purpose text.`,
  });

  if (detail !== "high") return;
  const chapterFiles = report.chapters?.flatMap((chapter) => chapter.files) || [];
  const missingFileFocus = chapterFiles.filter((file) => !file.reviewFocus?.length).map((file) => file.path);
  checks.push({
    id: "file-review-focus",
    label: "Per-file review focus",
    status: missingFileFocus.length ? "fail" : "pass",
    detail: missingFileFocus.length ? `High detail requires reviewFocus for each chapter file; missing ${sampleList(missingFileFocus)}.` : "Every chapter file has per-file reviewFocus.",
  });
}

function addReviewFocusCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  if (detail === "ultralow" || detail === "low") {
    checks.push({ id: "chapter-review-focus", label: "Chapter review focus", status: "pass", detail: `${labelDetail(detail)} does not require chapter-level reviewFocus.` });
    return;
  }
  const chapters = report.chapters || [];
  const missingIntent = chapters.filter((chapter) => !chapter.intent?.trim()).map((chapter) => chapter.title);
  const weakFocus = chapters
    .filter((chapter) => (chapter.reviewFocus?.length || 0) < (detail === "high" ? 2 : 1))
    .map((chapter) => chapter.title);
  const failures = [...missingIntent.map((title) => `${title} missing intent`), ...weakFocus.map((title) => `${title} has insufficient reviewFocus`)];
  checks.push({
    id: "chapter-review-focus",
    label: "Chapter review focus",
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? sampleList(failures) : `${chapters.length} chapter(s) include intent and required reviewFocus.`,
  });
}

function addValidationCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  const runs = report.validation?.runs || [];
  const hasMissingValidation = hasOwn(report, "missingValidation");
  const missingValidationCount = report.missingValidation?.length || 0;
  if (detail === "ultralow") {
    checks.push({
      id: "validation",
      label: "Validation documentation",
      status: runs.length || missingValidationCount ? "pass" : "warn",
      detail: runs.length || missingValidationCount ? `${runs.length} run(s), ${missingValidationCount} missing-validation note(s).` : "Ultralow detail permits omitted validation documentation for speed.",
    });
    return;
  }
  if (detail === "low") {
    checks.push({
      id: "validation",
      label: "Validation documentation",
      status: runs.length || missingValidationCount ? "pass" : "fail",
      detail: runs.length || missingValidationCount ? `${runs.length} run(s), ${missingValidationCount} missing-validation note(s).` : "Low detail requires at least one validation run or missingValidation note.",
    });
    return;
  }
  if (detail === "medium") {
    checks.push({
      id: "validation",
      label: "Validation documentation",
      status: report.validation && hasMissingValidation ? "pass" : "fail",
      detail: report.validation && hasMissingValidation ? `${runs.length} validation run(s); missingValidation field is present.` : "Medium detail requires validation and missingValidation fields, even if missingValidation is empty.",
    });
    return;
  }

  const chapters = report.chapters || [];
  const chaptersMissingValidation = chapters.filter((chapter) => !chapter.validation?.length).map((chapter) => chapter.title);
  const topLevelOk = runs.length > 0 || missingValidationCount > 0;
  checks.push({
    id: "validation",
    label: "Validation documentation",
    status: topLevelOk && chaptersMissingValidation.length === 0 ? "pass" : "fail",
    detail:
      topLevelOk && chaptersMissingValidation.length === 0
        ? `${runs.length} top-level validation run(s), ${missingValidationCount} missing-validation note(s), and chapter validation notes present.`
        : `High detail requires top-level validation/missingValidation and chapter validation notes. Missing chapter notes: ${sampleList(chaptersMissingValidation)}.`,
  });
}

function addRiskDecisionLimitationChecks(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  if (detail === "ultralow" || detail === "low") {
    checks.push({ id: "risk-decision-limitation", label: "Risks, decisions, limitations", status: "pass", detail: `${labelDetail(detail)} only requires critical risks when relevant.` });
    return;
  }
  if (detail === "medium") {
    checks.push({
      id: "risk-decision-limitation",
      label: "Risks, decisions, limitations",
      status: "pass",
      detail: "Medium detail records these when relevant; absence is rendered as none recorded.",
    });
    return;
  }

  const chapters = report.chapters || [];
  const chaptersMissingRisks = chapters.filter((chapter) => !chapter.risks?.length).map((chapter) => chapter.title);
  const failures = [
    ...(report.risks?.length ? [] : ["top-level risks or explicit low/no-risk callout"]),
    ...(report.decisions?.length ? [] : ["decisions or explicit no-notable-decisions entry"]),
    ...(report.knownLimitations?.length ? [] : ["knownLimitations or explicit none entry"]),
    ...chaptersMissingRisks.map((title) => `${title} chapter risks`),
  ];
  checks.push({
    id: "risk-decision-limitation",
    label: "Risks, decisions, limitations",
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? `High detail requires: ${sampleList(failures)}.` : "High-detail risks, decisions, limitations, and chapter risks are documented.",
  });
}

function addBehaviorFlowCheck(checks: DetailCheck[], detail: ReviewDetail, report: ReviewReport): void {
  if (detail !== "high") return;
  checks.push({
    id: "behavior-flow",
    label: "Behavior flow",
    status: report.behaviorFlow?.length ? "pass" : "warn",
    detail: report.behaviorFlow?.length ? `${report.behaviorFlow.length} behavior step(s) documented.` : "High detail should include behaviorFlow when behavior changed; omit only for non-behavioral changes.",
  });
}

function addDiffCoverageChecks(
  checks: DetailCheck[],
  detail: ReviewDetail,
  coverage: DetailProfileResult["coverage"],
  duplicateFiles: string[],
  diffAware: boolean,
): void {
  if (!diffAware || !coverage) {
    checks.push({
      id: "diff-coverage",
      label: "Diff-aware file coverage",
      status: detail === "ultralow" || detail === "low" ? "pass" : "warn",
      detail: detail === "ultralow" || detail === "low" ? `${labelDetail(detail)} can validate without git metadata.` : "Pass --cwd/--mode to validate changed-file coverage for medium/high detail.",
    });
    return;
  }

  if (detail === "ultralow" || detail === "low") {
    checks.push({
      id: "diff-coverage",
      label: "Diff-aware file coverage",
      status: "pass",
      detail: `${coverage.assignedFiles}/${coverage.changedFiles} changed file(s) referenced; ${detail} detail permits broad grouping.`,
    });
    return;
  }

  const failures = [
    ...(coverage.missingFiles.length ? [`unassigned changed files: ${sampleList(coverage.missingFiles)}`] : []),
    ...(coverage.staleFiles.length ? [`stale chapter paths: ${sampleList(coverage.staleFiles)}`] : []),
    ...(duplicateFiles.length ? [`duplicate chapter assignments: ${sampleList(duplicateFiles)}`] : []),
  ];
  checks.push({
    id: "diff-coverage",
    label: "Diff-aware file coverage",
    status: failures.length ? "fail" : "pass",
    detail: failures.length ? failures.join("; ") : `${coverage.assignedFiles}/${coverage.changedFiles} changed file(s) assigned exactly once to chapters.`,
  });
}

function diffCoverage(git: GitSnapshot, chapterFilePaths: string[]): DetailProfileResult["coverage"] {
  const changed = new Set(git.files.map((file) => file.path));
  const assigned = new Set(chapterFilePaths);
  return {
    changedFiles: changed.size,
    assignedFiles: Array.from(assigned).filter((path) => changed.has(path)).length,
    missingFiles: Array.from(changed).filter((path) => !assigned.has(path)),
    staleFiles: Array.from(assigned).filter((path) => !changed.has(path)),
    duplicateFiles: Array.from(countValues(chapterFilePaths).entries())
      .filter(([, count]) => count > 1)
      .map(([path]) => path),
  };
}

function countValues(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) || 0) + 1);
  return out;
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
