import type { GitSnapshot } from "../git.js";
import type { DataFlow, ReviewReport } from "../schema.js";
import type { ResolvedSnippet, SnippetResolution } from "../snippets.js";
import { analyzeDetailProfile } from "../detail.js";
import type { DetailProfileResult } from "../detail.js";
import { badge, escapeHtml, list, riskBadge, statusBadge, validationBadge } from "./components.js";

export function renderCodebaseReview(report: ReviewReport, git: GitSnapshot, commands: string[], snippets: SnippetResolution): string {
  const generatedAt = new Date().toISOString();
  const profile = report.reviewDetail ? analyzeDetailProfile({ report, git }) : undefined;
  return `<div class="page">
    ${renderHeader(report, git, generatedAt)}
    <div class="layout">
      ${renderToc(report, Boolean(profile), snippets.snippets.length)}
      <main class="content">
        ${renderStatus(report)}
        ${profile ? renderRigor(profile) : ""}
        ${snippets.warnings.length ? `<section id="snippet-warnings"><h2>Snippet warnings</h2>${list(snippets.warnings)}</section>` : ""}
        ${renderFileMap(report, git)}
        ${renderBuildingBlocks(report, snippets.byId)}
        ${renderWorkflows(report, snippets.byId)}
        ${renderDataFlows(report, snippets.byId)}
        ${renderReviewFocus(report, snippets.byId)}
        ${renderSnippets(snippets.snippets)}
        ${renderValidation(report)}
        ${renderAppendices(report, git, commands)}
      </main>
    </div>
  </div>`;
}

function renderHeader(report: ReviewReport, git: GitSnapshot, generatedAt: string): string {
  return `<header class="hero">
    <h1>${escapeHtml(report.title)}</h1>
    <p>${escapeHtml(report.status.currentState)}</p>
    <div class="meta">
      ${badge("codebase review", "neutral")}
      ${report.reviewDetail ? badge(`detail: ${report.reviewDetail}`, "neutral") : ""}
      ${report.status.confidence ? confidenceBadge(report.status.confidence) : ""}
      ${badge(`mode: ${git.mode}`)}
      ${badge(`${git.totals.files} changed files`)}
      ${badge(`+${git.totals.added} / -${git.totals.deleted}`)}
    </div>
    <div class="stat-grid" aria-label="review provenance">
      ${stat("Repository", git.repoRoot)}
      ${stat("Branch", git.branch)}
      ${stat("HEAD", git.headSha)}
      ${stat("Base", git.baseLabel)}
      ${stat("Generated", generatedAt)}
      ${stat("Diff mode", git.mode)}
      ${stat("Changed files", String(git.totals.files))}
      ${stat("Line delta", `+${git.totals.added} / -${git.totals.deleted}`)}
    </div>
  </header>`;
}

function confidenceBadge(confidence: string): string {
  if (confidence === "high") return badge("confidence: high", "validation-passed");
  if (confidence === "medium") return badge("confidence: medium", "validation-partial");
  return badge("confidence: low", "validation-failed");
}

function stat(label: string, value: string): string {
  return `<div class="stat"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderToc(report: ReviewReport, hasRigor: boolean, snippetCount: number): string {
  return `<nav class="toc" aria-label="Review artifact navigation">
    <h3>Codebase map</h3>
    <p class="small muted">This artifact explains how the current code works. Raw diffs are intentionally omitted.</p>
    <a href="#status">Current status</a>
    ${hasRigor ? `<a href="#rigor">Artifact checks</a>` : ""}
    <a href="#file-map">File map</a>
    ${report.buildingBlocks?.length ? `<a href="#building-blocks">Building blocks</a>` : ""}
    ${report.workflows?.length ? `<a href="#workflows">Workflows</a>` : ""}
    ${report.dataFlows?.length ? `<a href="#data-flows">Data flows</a>` : ""}
    ${report.reviewFocus?.length ? `<a href="#review-focus">Review focus</a>` : ""}
    ${snippetCount ? `<a href="#snippets">Code snippets (${snippetCount})</a>` : ""}
    <a href="#validation">Validation</a>
    <a href="#appendices">Appendices</a>
  </nav>`;
}

function renderStatus(report: ReviewReport): string {
  return `<section id="status">
    <h2>Current status</h2>
    <div class="grid-2">
      <div class="card"><h3>What the codebase currently does</h3><p>${escapeHtml(report.status.currentState)}</p></div>
      <div class="card"><h3>Review scope</h3><p>${escapeHtml(report.status.reviewScope)}</p></div>
      <div class="card"><h3>What changed at a high level</h3><p>${escapeHtml(report.status.changeSummary || "Not specified.")}</p></div>
      <div class="card"><h3>Known limitations</h3>${list(report.knownLimitations)}</div>
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
    <h2>Artifact checks</h2>
    <div class="meta">
      ${badge(`detail: ${profile.detail}`, "neutral")}
      ${badge(`${counts.pass} passed`, "validation-passed")}
      ${counts.warn ? badge(`${counts.warn} warnings`, "validation-partial") : ""}
      ${counts.fail ? badge(`${counts.fail} failures`, "validation-failed") : ""}
    </div>
    ${profile.coverage ? `<p class="muted">File-map coverage: ${profile.coverage.mappedChangedFiles}/${profile.coverage.changedFiles} changed file(s) represented.</p>` : ""}
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

function renderFileMap(report: ReviewReport, git: GitSnapshot): string {
  const gitByPath = new Map(git.files.map((file) => [file.path, file]));
  return `<section id="file-map">
    <h2>What lives where</h2>
    <p class="section-lead">Changed files and important adjacent files, described by current responsibility instead of raw diff hunks.</p>
    <div class="grid-2">${report.fileMap
      .map((entry) => {
        const gitFile = gitByPath.get(entry.path);
        return `<div class="file-card">
          <div class="file-path"><code>${escapeHtml(entry.path)}</code></div>
          <div class="meta">${gitFile ? statusBadge(gitFile.status) + badge(`+${gitFile.added} / -${gitFile.deleted}`) : badge(entry.changed === false ? "context file" : "not in collected diff", "neutral")}${entry.status ? badge(entry.status) : ""}</div>
          <p>${escapeHtml(entry.role)}</p>
          ${entry.whyRelevant ? `<p><strong>Why relevant:</strong> ${escapeHtml(entry.whyRelevant)}</p>` : ""}
          ${entry.responsibilities?.length ? `<h4>Responsibilities</h4>${list(entry.responsibilities)}` : ""}
          ${entry.interactsWith?.length ? `<h4>Interacts with</h4><div class="pill-row">${entry.interactsWith.map((path) => `<code>${escapeHtml(path)}</code>`).join(" ")}</div>` : ""}
          ${renderSnippetLinks(entry.snippetIds)}
        </div>`;
      })
      .join("")}</div>
  </section>`;
}

function renderBuildingBlocks(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.buildingBlocks?.length) return "";
  return `<section id="building-blocks"><h2>Building blocks</h2><div class="grid-2">${report.buildingBlocks
    .map((block) => `<div class="block-card">
      <h3>${escapeHtml(block.name)} ${badge(block.kind)}</h3>
      <p>${escapeHtml(block.description)}</p>
      <h4>Files</h4><div class="pill-row">${block.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>
      ${block.responsibilities?.length ? `<h4>Responsibilities</h4>${list(block.responsibilities)}` : ""}
      ${block.inputs?.length || block.outputs?.length ? `<div class="grid-2"><div><h4>Inputs</h4>${list(block.inputs)}</div><div><h4>Outputs</h4>${list(block.outputs)}</div></div>` : ""}
      ${block.dependencies?.length ? `<h4>Dependencies</h4>${list(block.dependencies)}` : ""}
      ${renderSnippetLinks(block.snippetIds, snippets)}
    </div>`)
    .join("")}</div></section>`;
}

function renderWorkflows(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.workflows?.length) return "";
  return `<section id="workflows"><h2>Workflows</h2>${report.workflows
    .map((workflow) => `<div class="card"><h3>${escapeHtml(workflow.name)}</h3><p>${escapeHtml(workflow.summary)}</p>${workflow.trigger ? `<p><strong>Trigger:</strong> ${escapeHtml(workflow.trigger)}</p>` : ""}<div class="flow">${workflow.steps
      .map((step, index) => `<div class="flow-step"><div class="flow-num">${index + 1}</div><div><h4>${escapeHtml(step.label)}</h4><p>${escapeHtml(step.description)}</p>${step.files?.length ? `<div class="pill-row">${step.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}${renderSnippetLinks(step.snippetIds, snippets)}</div></div>`)
      .join("")}</div></div>`)
    .join("")}</section>`;
}

function renderDataFlows(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.dataFlows?.length) return "";
  return `<section id="data-flows"><h2>Data flows</h2>${report.dataFlows.map((flow) => renderDataFlow(flow, snippets)).join("")}</section>`;
}

function renderDataFlow(flow: DataFlow, snippets: Map<string, ResolvedSnippet>): string {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const used = new Set<string>();
  const chain: string[] = [];
  let current = flow.edges[0]?.from;
  while (current && !used.has(current)) {
    used.add(current);
    chain.push(current);
    const next = flow.edges.find((edge) => edge.from === current && !used.has(edge.to));
    if (!next) break;
    current = next.to;
  }
  if (current && !used.has(current)) chain.push(current);
  const orderedNodes = chain.length >= 2 ? chain.map((id) => nodes.get(id)).filter(Boolean) : flow.nodes;
  return `<div class="card"><h3>${escapeHtml(flow.name)}</h3>${flow.summary ? `<p>${escapeHtml(flow.summary)}</p>` : ""}<div class="arrow-diagram">${orderedNodes
    .map((node, index) => {
      if (!node) return "";
      const edge = index < orderedNodes.length - 1 ? flow.edges.find((candidate) => candidate.from === node.id && candidate.to === orderedNodes[index + 1]?.id) : undefined;
      return `<div class="diagram-node"><strong>${escapeHtml(node.label)}</strong><div>${node.kind ? badge(node.kind, `node-${node.kind}`) : ""}</div>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}${node.files?.length ? `<div class="pill-row">${node.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}${renderSnippetLinks(node.snippetIds, snippets)}</div>${edge ? `<div class="diagram-arrow">→<span class="edge-label">${escapeHtml(edge.label || "")}</span></div>` : ""}`;
    })
    .join("")}</div></div>`;
}

function renderReviewFocus(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.reviewFocus?.length && !report.risks?.length && !report.decisions?.length) return "";
  return `<section id="review-focus"><h2>Review focus</h2>
    ${report.reviewFocus?.length ? `<div class="grid-2">${report.reviewFocus.map((focus) => `<div class="focus-card"><h3>${escapeHtml(focus.area)} ${riskBadge(focus.severity)}</h3><p>${escapeHtml(focus.question)}</p>${focus.files?.length ? `<div class="pill-row">${focus.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}${renderSnippetLinks(focus.snippetIds, snippets)}</div>`).join("")}</div>` : ""}
    ${renderRisks(report, snippets)}
    ${renderDecisions(report, snippets)}
  </section>`;
}

function renderSnippets(snippets: ResolvedSnippet[]): string {
  if (!snippets.length) return "";
  return `<section id="snippets"><h2>Code snippets</h2><p class="section-lead">Curated line ranges from the local codebase. Raw diffs are intentionally omitted.</p>${snippets.map(renderSnippet).join("")}</section>`;
}

function renderSnippet(snippet: ResolvedSnippet): string {
  return `<article class="snippet" id="snippet-${escapeHtml(snippet.id)}"><div class="snippet-head"><strong><code>${escapeHtml(snippet.path)}:${snippet.startLine}-${snippet.endLine}</code></strong><div class="snippet-caption">${escapeHtml(snippet.caption)} ${snippet.source ? badge(snippet.source) : ""}</div></div>${snippet.error ? `<div class="snippet-error">${escapeHtml(snippet.error)}</div>` : `<table class="code-table"><tbody>${snippet.lines.map((line) => `<tr class="code-row${line.highlighted ? " highlight" : ""}"><td class="line-no">${line.number}</td><td class="line-code">${escapeHtml(line.text)}</td></tr>`).join("")}</tbody></table>`}</article>`;
}

function renderValidation(report: ReviewReport): string {
  const tests = report.validation?.relevantTests || [];
  const runs = report.validation?.runs || [];
  return `<section id="validation">
    <h2>Validation</h2>
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

function renderAppendices(report: ReviewReport, git: GitSnapshot, commands: string[]): string {
  const mapped = new Set(report.fileMap.filter((entry) => entry.changed !== false).map((entry) => entry.path));
  const unmapped = git.files.filter((file) => !mapped.has(file.path));
  return `<section id="appendices"><h2>Appendices</h2>
    <div class="card"><h3>Changed files from git metadata</h3><table><thead><tr><th>File</th><th>Status</th><th>Delta</th><th>Mapped?</th></tr></thead><tbody>${git.files.map((file) => `<tr><td><code>${escapeHtml(file.path)}</code></td><td>${statusBadge(file.status)}</td><td>+${file.added} / -${file.deleted}</td><td>${mapped.has(file.path) ? badge("yes", "validation-passed") : badge("no", "validation-partial")}</td></tr>`).join("")}</tbody></table></div>
    ${unmapped.length ? `<div class="card"><h3>Unmapped changed files</h3><p class="muted">These files appeared in git metadata but were not represented in fileMap.</p>${list(unmapped.map((file) => file.path))}</div>` : ""}
    <div class="card"><h3>Commands & provenance</h3><pre class="commands">${escapeHtml(commands.join("\n"))}</pre></div>
  </section>`;
}

function renderRisks(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.risks?.length) return "";
  return `<h3>Risks</h3><div class="grid-2">${report.risks
    .map((risk) => `<div class="focus-card">${riskBadge(risk.severity)}${risk.area ? badge(risk.area) : ""}<p>${escapeHtml(risk.description)}</p>${risk.mitigation ? `<p><strong>Mitigation:</strong> ${escapeHtml(risk.mitigation)}</p>` : ""}${risk.files?.length ? `<div class="pill-row">${risk.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}${renderSnippetLinks(risk.snippetIds, snippets)}</div>`)
    .join("")}</div>`;
}

function renderDecisions(report: ReviewReport, snippets: Map<string, ResolvedSnippet>): string {
  if (!report.decisions?.length) return "";
  return `<h3>Decisions</h3><div class="grid-2">${report.decisions
    .map((decision) => `<div class="focus-card"><strong>${escapeHtml(decision.decision)}</strong>${decision.rationale ? `<p>${escapeHtml(decision.rationale)}</p>` : ""}${decision.alternatives?.length ? `<h4>Alternatives</h4>${list(decision.alternatives)}` : ""}${decision.files?.length ? `<div class="pill-row">${decision.files.map((file) => `<code>${escapeHtml(file)}</code>`).join(" ")}</div>` : ""}${renderSnippetLinks(decision.snippetIds, snippets)}</div>`)
    .join("")}</div>`;
}

function renderSnippetLinks(ids?: string[], snippets?: Map<string, ResolvedSnippet>): string {
  if (!ids?.length) return "";
  return `<div class="linked-snippets"><strong>Snippets:</strong> ${ids.map((id) => snippets && !snippets.has(id) ? `<span class="warning">${escapeHtml(id)} missing</span>` : `<a href="#snippet-${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(" ")}</div>`;
}
