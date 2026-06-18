import type { GitFileDiff, GitSnapshot } from "../git.js";
import type { ReviewChapter, ReviewReport } from "../schema.js";
import { analyzeDetailProfile } from "../detail.js";
import type { DetailProfileResult } from "../detail.js";
import { badge, escapeHtml, list, renderDiff, riskBadge, statusBadge, validationBadge } from "./components.js";

type NormalizedChapter = ReviewChapter & { sourceIndex: number; derived: boolean };

export function renderChapters(report: ReviewReport, git: GitSnapshot, commands: string[]): string {
  const generatedAt = new Date().toISOString();
  const chapters = normalizeChapters(report);
  const gitByPath = new Map(git.files.map((f) => [f.path, f]));
  const profile = report.reviewDetail ? analyzeDetailProfile({ report, git }) : undefined;
  const omitRawDiffs = report.reviewDetail === "ultralow";
  const chapterFileSet = new Set(chapters.flatMap((chapter) => chapter.files.map((file) => file.path)));
  const ungrouped = git.files.filter((file) => !chapterFileSet.has(file.path));
  const missing = chapters.flatMap((chapter) => chapter.files.filter((file) => !gitByPath.has(file.path)).map((file) => ({ chapter, path: file.path })));

  const body = `<div class="page">
    ${renderHeader(report, git, generatedAt)}
    <div class="layout">
      ${renderToc(chapters, ungrouped, missing, Boolean(profile))}
      <main class="content">
        ${renderOverview(report)}
        ${profile ? renderRigor(profile) : ""}
        ${renderChapterBody(chapters, gitByPath, omitRawDiffs)}
        ${renderValidation(report)}
        ${renderAppendices(report, git, commands, ungrouped, missing, omitRawDiffs)}
      </main>
    </div>
  </div>`;
  return body;
}

function normalizeChapters(report: ReviewReport): NormalizedChapter[] {
  const source = report.chapters?.length
    ? report.chapters.map((chapter, sourceIndex) => ({ ...chapter, sourceIndex, derived: false }))
    : report.changes.map((change, sourceIndex) => ({
        title: change.title,
        summary: change.summary,
        sequence: sourceIndex + 1,
        intent: change.reviewerNotes?.join(" "),
        files: change.files.map((file) => ({ path: file.path, purpose: file.purpose, risk: file.risk })),
        reviewFocus: change.reviewerNotes,
        risks: change.risk ? [`Overall chapter risk: ${change.risk}`] : undefined,
        sourceIndex,
        derived: true,
      }));

  return source.sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.sourceIndex - b.sourceIndex);
}

function renderHeader(report: ReviewReport, git: GitSnapshot, generatedAt: string): string {
  return `<header class="hero">
    <h1>${escapeHtml(report.title)}</h1>
    <p>${escapeHtml(report.summary.intent)}</p>
    <div class="meta">
      ${report.summary.changeType ? badge(report.summary.changeType, "neutral") : ""}
      ${report.reviewDetail ? badge(`detail: ${report.reviewDetail}`, "neutral") : ""}
      ${badge(`mode: ${git.mode}`)}
      ${badge(`${git.totals.files} files`)}
      ${badge(`+${git.totals.added} / -${git.totals.deleted}`)}
    </div>
    <div class="stat-grid" aria-label="review provenance">
      ${stat("Repository", git.repoRoot)}
      ${stat("Branch", git.branch)}
      ${stat("HEAD", git.headSha)}
      ${stat("Base", git.baseLabel)}
      ${stat("Generated", generatedAt)}
      ${stat("Diff mode", git.mode)}
      ${stat("Files", String(git.totals.files))}
      ${stat("Line delta", `+${git.totals.added} / -${git.totals.deleted}`)}
    </div>
  </header>`;
}

function stat(label: string, value: string): string {
  return `<div class="stat"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderToc(chapters: NormalizedChapter[], ungrouped: GitFileDiff[], missing: Array<{ path: string }>, hasRigor: boolean): string {
  return `<nav class="toc" aria-label="Review artifact navigation">
    <h3>Review order</h3>
    <p class="small">This order is agent-curated from the final diff, not commit chronology.</p>
    <a href="#overview">Overview</a>
    ${hasRigor ? `<a href="#rigor">Review rigor</a>` : ""}
    ${chapters.map((chapter, index) => `<a href="#${chapterId(index)}">${index + 1}. ${escapeHtml(chapter.title)}</a>`).join("")}
    <a href="#validation">Tests Done & Validation</a>
    <a href="#appendices">Appendices</a>
    ${ungrouped.length ? `<a href="#ungrouped">Ungrouped files (${ungrouped.length})</a>` : ""}
    ${missing.length ? `<a href="#missing">Missing chapter files (${missing.length})</a>` : ""}
  </nav>`;
}

function renderOverview(report: ReviewReport): string {
  const riskItems = report.risks?.map((risk) => `${risk.severity.toUpperCase()}${risk.area ? `/${risk.area}` : ""}: ${risk.description}`) || [];
  return `<section id="overview">
    <h2>Compact overview</h2>
    <div class="overview-grid">
      <div class="card"><h3>Intent</h3><p>${escapeHtml(report.summary.intent)}</p></div>
      <div class="card"><h3>Change type</h3><p>${report.summary.changeType ? badge(report.summary.changeType) : `<span class="empty">Not specified</span>`}</p></div>
      <div class="card"><h3>How it works</h3><p>${escapeHtml(report.summary.howItWorks || "Not specified.")}</p></div>
      <div class="card"><h3>High-level risks</h3>${list(riskItems)}</div>
    </div>
  </section>`;
}

function renderRigor(profile: DetailProfileResult): string {
  const counts = profile.checks.reduce(
    (acc, check) => {
      acc[check.status]++;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  return `<section id="rigor">
    <h2>Review rigor</h2>
    <div class="meta">
      ${badge(`detail: ${profile.detail}`, "neutral")}
      ${badge(`${counts.pass} passed`, "validation-passed")}
      ${counts.warn ? badge(`${counts.warn} warnings`, "validation-partial") : ""}
      ${counts.fail ? badge(`${counts.fail} failures`, "validation-failed") : ""}
    </div>
    ${profile.coverage ? `<p class="muted">File coverage: ${profile.coverage.assignedFiles}/${profile.coverage.changedFiles} changed file(s) assigned to chapters.</p>` : ""}
    <table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${profile.checks
      .map((check) => `<tr><td>${escapeHtml(check.label)}</td><td>${checkStatusBadge(check.status)}</td><td>${escapeHtml(check.detail)}</td></tr>`)
      .join("")}</tbody></table>
  </section>`;
}

function checkStatusBadge(status: "pass" | "warn" | "fail"): string {
  if (status === "pass") return badge("pass", "validation-passed");
  if (status === "warn") return badge("warn", "validation-partial");
  return badge("fail", "validation-failed");
}

function renderChapterBody(chapters: NormalizedChapter[], gitByPath: Map<string, GitFileDiff>, omitRawDiffs: boolean): string {
  return `<section id="chapters">
    <h2>Chapters</h2>
    ${chapters
      .map((chapter, index) => {
        const diffs = chapter.files.map((file) => ({ reportFile: file, gitFile: gitByPath.get(file.path) }));
        const chapterRisk = highestRisk(chapter.files.map((file) => file.risk));
        return `<article class="chapter" id="${chapterId(index)}">
          <div class="chapter-head">
            <h3>${index + 1}. ${escapeHtml(chapter.title)} ${riskBadge(chapterRisk)}</h3>
            <p>${escapeHtml(chapter.summary)}</p>
            <div class="meta">${badge(`${chapter.files.length} files`)}${chapter.derived ? badge("derived from changes", "neutral") : badge("agent-curated", "neutral")}</div>
          </div>
          <div class="chapter-body">
            ${chapter.intent ? `<p><strong>Intent:</strong> ${escapeHtml(chapter.intent)}</p>` : ""}
            ${chapter.dependsOn?.length ? `<p><strong>Depends on:</strong> ${chapter.dependsOn.map(escapeHtml).join(", ")}</p>` : ""}
            ${renderChapterFilesTable(chapter, gitByPath)}
            <div class="chapter-grid">
              <div><h4>Review focus</h4>${list(chapter.reviewFocus)}</div>
              <div><h4>Chapter risks</h4>${list(chapter.risks)}</div>
              <div><h4>Chapter validation notes</h4>${list(chapter.validation)}</div>
            </div>
            <h4>${omitRawDiffs ? "Chapter file summary" : "Chapter-scoped diffs"}</h4>
            ${omitRawDiffs ? `<div class="diff-note">Raw diffs are omitted for ultralow detail. Use a higher detail tier for embedded patch text.</div>` : ""}
            ${diffs
              .map(({ reportFile, gitFile }) =>
                gitFile
                  ? omitRawDiffs
                    ? renderFileSummary(gitFile, reportFile.purpose)
                    : renderFileDetails(gitFile, reportFile.purpose)
                  : `<div class="warning">Chapter references <code>${escapeHtml(reportFile.path)}</code>, but that file is not present in the collected git diff.</div>`,
              )
              .join("")}
          </div>
        </article>`;
      })
      .join("")}
  </section>`;
}

function renderChapterFilesTable(chapter: NormalizedChapter, gitByPath: Map<string, GitFileDiff>): string {
  return `<table>
    <thead><tr><th>File</th><th>Status</th><th>Purpose</th><th>Review focus</th><th>Delta</th></tr></thead>
    <tbody>${chapter.files
      .map((file) => {
        const gitFile = gitByPath.get(file.path);
        return `<tr>
          <td><code>${escapeHtml(file.path)}</code>${!gitFile ? `<div class="warning">Missing from git diff</div>` : ""}</td>
          <td>${gitFile ? statusBadge(gitFile.status) : badge("missing", "risk-medium")}</td>
          <td>${escapeHtml(file.purpose || "")}${riskBadge(file.risk)}</td>
          <td>${file.reviewFocus?.length ? list(file.reviewFocus) : `<span class="empty">None recorded</span>`}</td>
          <td>${gitFile ? `+${gitFile.added} / -${gitFile.deleted}` : "—"}</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

function renderFileDetails(file: GitFileDiff, purpose?: string): string {
  return `<details>
    <summary>${statusBadge(file.status)} <code>${escapeHtml(file.path)}</code> <span class="muted">+${file.added} / -${file.deleted}</span>${purpose ? ` — ${escapeHtml(purpose)}` : ""}</summary>
    ${renderDiff(file.patch, file.note)}
  </details>`;
}

function renderFileSummary(file: GitFileDiff, purpose?: string): string {
  return `<div class="card">${statusBadge(file.status)} <code>${escapeHtml(file.path)}</code> <span class="muted">+${file.added} / -${file.deleted}</span>${purpose ? `<p>${escapeHtml(purpose)}</p>` : ""}${file.note ? `<p class="muted">${escapeHtml(file.note)}</p>` : ""}</div>`;
}

function renderValidation(report: ReviewReport): string {
  const tests = report.validation?.relevantTests || [];
  const runs = report.validation?.runs || [];
  return `<section id="validation">
    <h2>Tests Done & Validation</h2>
    <h3>Relevant tests</h3>
    ${tests.length
      ? `<table><thead><tr><th>Name</th><th>Location</th><th>Description</th><th>Related files</th></tr></thead><tbody>${tests
          .map((test) => `<tr><td>${escapeHtml(test.name)}</td><td>${escapeHtml(test.file || "")}${test.line ? `:${test.line}` : ""}</td><td>${escapeHtml(test.description)}</td><td>${(test.relatedFiles || []).map((f) => `<code>${escapeHtml(f)}</code>`).join("<br>")}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="empty">No relevant tests recorded.</p>`}
    <h3>Validation runs</h3>
    ${runs.length
      ? `<table><thead><tr><th>Name</th><th>Command</th><th>Result</th><th>Evidence</th><th>Notes</th></tr></thead><tbody>${runs
          .map((run) => `<tr><td>${escapeHtml(run.name)}</td><td>${run.command ? `<code>${escapeHtml(run.command)}</code>` : ""}</td><td>${validationBadge(run.result)}</td><td>${escapeHtml(run.evidence || "")}</td><td>${escapeHtml(run.notes || "")}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="empty">No validation runs recorded.</p>`}
    <h3>Missing validation</h3>
    ${list(report.missingValidation)}
  </section>`;
}

function renderAppendices(
  report: ReviewReport,
  git: GitSnapshot,
  commands: string[],
  ungrouped: GitFileDiff[],
  missing: Array<{ chapter: NormalizedChapter; path: string }>,
  omitRawDiffs: boolean,
): string {
  return `<section id="appendices">
    <h2>Appendices</h2>
    ${ungrouped.length ? `<div id="ungrouped" class="card"><h3>Ungrouped / review separately</h3><p>These files are present in the git diff but were not assigned to a chapter.</p>${ungrouped.map((file) => (omitRawDiffs ? renderFileSummary(file) : renderFileDetails(file))).join("")}</div>` : ""}
    ${missing.length ? `<div id="missing" class="card"><h3>Chapter files missing from git diff</h3><ul>${missing.map((item) => `<li><code>${escapeHtml(item.path)}</code> referenced by “${escapeHtml(item.chapter.title)}”</li>`).join("")}</ul></div>` : ""}
    <div class="card"><h3>${omitRawDiffs ? "All changed files" : "All changed files / raw diffs"}</h3>${omitRawDiffs ? `<p class="muted">Raw diffs are omitted for ultralow detail.</p>${git.files.map((file) => renderFileSummary(file)).join("")}` : git.files.map((file) => renderFileDetails(file)).join("")}</div>
    ${renderBehaviorFlow(report)}
    ${renderDecisions(report)}
    ${renderRisks(report)}
    <div class="card"><h3>Known limitations</h3>${list(report.knownLimitations)}</div>
    <div class="card"><h3>Commands & provenance</h3><pre class="commands">${escapeHtml(commands.join("\n"))}</pre></div>
  </section>`;
}

function renderBehaviorFlow(report: ReviewReport): string {
  if (!report.behaviorFlow?.length) return `<div class="card"><h3>Behavior flow</h3><p class="empty">None recorded.</p></div>`;
  return `<div class="card"><h3>Behavior flow</h3><ol>${report.behaviorFlow
    .map((step) => `<li><strong>${escapeHtml(step.label)}</strong>: ${escapeHtml(step.description)}${step.files?.length ? `<br>${step.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}` : ""}</li>`)
    .join("")}</ol></div>`;
}

function renderDecisions(report: ReviewReport): string {
  if (!report.decisions?.length) return `<div class="card"><h3>Decisions</h3><p class="empty">None recorded.</p></div>`;
  return `<div class="card"><h3>Decisions</h3>${report.decisions
    .map((decision) => `<div class="card"><strong>${escapeHtml(decision.decision)}</strong>${decision.rationale ? `<p>${escapeHtml(decision.rationale)}</p>` : ""}${decision.alternatives?.length ? `<h4>Alternatives</h4>${list(decision.alternatives)}` : ""}</div>`)
    .join("")}</div>`;
}

function renderRisks(report: ReviewReport): string {
  if (!report.risks?.length) return `<div class="card"><h3>Risks</h3><p class="empty">None recorded.</p></div>`;
  return `<div class="card"><h3>Risks</h3>${report.risks
    .map((risk) => `<div class="card">${riskBadge(risk.severity)}${risk.area ? badge(risk.area) : ""}<p>${escapeHtml(risk.description)}</p>${risk.mitigation ? `<p><strong>Mitigation:</strong> ${escapeHtml(risk.mitigation)}</p>` : ""}${risk.files?.length ? risk.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ") : ""}</div>`)
    .join("")}</div>`;
}

function highestRisk(values: Array<string | undefined>): string | undefined {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  if (values.includes("low")) return "low";
  return undefined;
}

function chapterId(index: number): string {
  return `chapter-${index + 1}`;
}
