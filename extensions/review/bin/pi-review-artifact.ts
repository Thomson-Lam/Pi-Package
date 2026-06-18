#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateReport, reportJsonSchema } from "../src/schema.js";
import type { ReviewDetail, ReviewReport } from "../src/schema.js";
import { collectGitSnapshot } from "../src/git.js";
import type { DiffMode, GitSnapshot } from "../src/git.js";
import { renderHtml } from "../src/render.js";
import type { ArtifactTemplate } from "../src/render.js";
import { analyzeDetailProfile, parseReviewDetail } from "../src/detail.js";
import { loadDevFixture, parseDevRenderDetail, parseDevFixtureName, REVIEW_DETAILS } from "../src/fixtures.js";
import type { DevRenderDetail } from "../src/fixtures.js";
import { escapeHtml } from "../src/templates/components.js";
import { openFile } from "../src/open.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

function log(s: string) {
  if (!has("--json")) console.log(s);
}

function warn(s: string) {
  if (!has("--json")) console.error(s);
}

function usage(exitCode = 0): never {
  console.log(shortUsage());
  process.exit(exitCode);
}

function shortUsage(): string {
  return `pi-review-artifact commands:
  guide [--template codebase]
  example [--template codebase]
  schema --json
  dev-render [--template codebase] [--fixture comprehensive] [--detail ultralow|low|medium|high|all] [--cwd <path>] [--project-cwd <path>] [--out repo|localpi|global] [--output <file>] [--output-dir <dir>] [--open|--no-open] [--json]
  scaffold [--template codebase] [--cwd <repo>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--output <file>] [--json]
  validate --stdin|--input <file> [--template codebase] [--cwd <repo>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--json]
  render --stdin|--input <file> [--template codebase] [--output <file>] [--out repo|localpi|global] [--cwd <repo>] [--project-cwd <path>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--open|--no-open] [--json]

Notes:
  - The only supported artifact template is "codebase".
  - Raw diffs are never rendered. Use curated snippet line ranges instead.
  - baseRef mode requires --base <ref>.
  - --out repo writes under <git-root>/html-reviews/.
  - --out localpi writes under <git-root>/.pi/reviews/.
  - --out global writes under ~/.pi/agent/reviews/<project-slug>/; pass --project-cwd to control the slug.
  - Rendered HTML filenames use the slugged report title as <subject>.html; spaces and non-alphanumeric symbols become hyphens.
  - dev-render uses static dummy JSON and git fixtures; it does not inspect real git or invoke an agent.
  - scaffold writes a TODO_REPLACE draft; validate/render reject unresolved placeholders.
  - render and dev-render default to --out repo and open the artifact unless --no-open is passed.

Run "pi-review-artifact --help" for examples and detail-tier behavior.`;
}

function cliHelpText(): string {
  return `${shortUsage()}

Workflow:
  1. For low/ultralow, generate compact codebase-review JSON and pass it directly to render --stdin.
  2. For medium/high, scaffold creates a JSON draft from changed-file metadata.
  3. An agent or human replaces every TODO_REPLACE placeholder and adds snippet line-range references.
  4. render validates schema/placeholders/detail coverage, resolves snippets from local files, and writes self-contained HTML.
  5. validate remains available for manual debugging and smoke checks.

Examples:
  node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
  node dist/bin/pi-review-artifact.js scaffold --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review.json
  node dist/bin/pi-review-artifact.js render --input /tmp/review.json --template codebase --cwd . --mode worktree --include-untracked --detail medium --out repo --no-open
  node dist/bin/pi-review-artifact.js render --stdin --template codebase --cwd . --mode worktree --include-untracked --detail low --out localpi --no-open < /tmp/low-review.json

Detail tiers:
  ultralow  Fastest compact handoff. Status, file map, optional workflow/block, 0-3 snippets, max ~80 snippet lines.
  low       Compact internal handoff. File map, at least one workflow/block/data flow, 1-6 snippets, validation or missingValidation.
  medium    Default shareable artifact. Full changed-file map, building blocks, workflow/data flow, 2-12 snippets, validation.
  high      Rigorous map. Exhaustive context, multiple flows/focus/risk/decision sections, 4-25 snippets, validation evidence.

Diff modes:
  worktree  git diff HEAD; /pr commonly passes --include-untracked for new files.
  staged    git diff --cached.
  baseRef   git diff <base>; requires --base <ref>.

Notes on validate vs render:
  validate only collects git metadata when --cwd is supplied, because diff-aware tier checks need changed-file coverage.
  render always collects git metadata because the artifact provenance and diffs are rendered from local git state.
  dev-render never collects git metadata; it renders static dummy fixtures through the same HTML renderer for cheap development checks.`;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) return usage();
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(cliHelpText());
    return;
  }

  try {
    if (cmd === "schema") {
      if (has("--json")) {
        console.log(JSON.stringify(reportJsonSchema(), null, 2));
        return;
      }
      return usage(1);
    }

    if (cmd === "guide") {
      validateTemplate();
      console.log(guideText());
      return;
    }

    if (cmd === "example") {
      validateTemplate();
      console.log(JSON.stringify(exampleReport(), null, 2));
      return;
    }

    if (cmd === "dev-render") {
      const template = validateTemplate();
      const fixture = parseDevFixtureName(arg("--fixture"));
      const detail = parseDevRenderDetail(arg("--detail"), "all");
      const artifacts = renderDevFixtures({ fixture, detail, template });
      const shouldOpen = has("--open") || !has("--no-open");
      if (shouldOpen) {
        try {
          openFile(artifacts.openTarget);
        } catch {
          log("Could not open dev artifact automatically.");
        }
      }
      if (has("--json")) console.log(JSON.stringify(artifacts));
      else {
        for (const artifact of artifacts.artifacts) console.log(`Artifact: ${artifact.path} (${artifact.detail} fixture)`);
        if (artifacts.index) console.log(`Index: ${artifacts.index}`);
      }
      return;
    }

    if (cmd === "scaffold") {
      validateTemplate();
      const detail = validateDetail(true) || "medium";
      const { mode, base, cwd, maxPatchBytes, maxFilePatchBytes } = renderOptionsFromFlags();
      const git = collectGitSnapshot({
        cwd,
        mode,
        base,
        includeUntracked: has("--include-untracked"),
        maxPatchBytes,
        maxFilePatchBytes,
      });
      const report = scaffoldReport(git, detail);
      const json = JSON.stringify(report, null, 2);
      const output = arg("--output");
      if (output) {
        const outputPath = resolve(output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${json}\n`, "utf8");
        if (has("--json")) console.log(JSON.stringify({ scaffold: outputPath, files: git.files.length, detail }));
        else console.log(`Scaffold: ${outputPath} (${git.files.length} files, detail: ${detail})`);
      } else {
        console.log(json);
      }
      return;
    }

    if (cmd === "validate" || cmd === "render") {
      const template = validateTemplate();
      const input = readInputOrExit();
      log("Validating report JSON...");
      let report: ReviewReport;
      try {
        report = validateReport(JSON.parse(input));
      } catch (e) {
        console.error("Validation failed:");
        console.error(formatValidationError(e));
        process.exit(1);
      }
      const placeholders = findPlaceholders(report);
      if (placeholders.length) {
        console.error("Validation failed: unresolved scaffold placeholders remain:");
        console.error(placeholders.map((p) => `- ${p}`).join("\n"));
        process.exit(1);
      }

      const requestedDetail = validateDetail(false);
      const shouldEnforceDetail = Boolean(requestedDetail);

      if (cmd === "validate") {
        let git: GitSnapshot | undefined;
        if (has("--cwd")) {
          const { mode, base, cwd, maxPatchBytes, maxFilePatchBytes } = renderOptionsFromFlags();
          git = collectGitSnapshot({
            cwd,
            mode,
            base,
            includeUntracked: has("--include-untracked"),
            maxPatchBytes,
            maxFilePatchBytes,
          });
        }
        if (shouldEnforceDetail) enforceDetailProfile(report, requestedDetail, git);
        log("Validation successful.");
        if (has("--json")) {
          const profile = shouldEnforceDetail ? analyzeDetailProfile({ report, requestedDetail, git }) : undefined;
          console.log(JSON.stringify({ ok: true, detail: profile?.detail, warnings: profile?.warnings || [] }));
        }
        return;
      }

      const { mode, base, cwd, maxPatchBytes, maxFilePatchBytes } = renderOptionsFromFlags();

      log("Reading git repository metadata...");
      log("Collecting changed file list...");
      log("Collecting changed-file metadata...");
      const git = collectGitSnapshot({
        cwd,
        mode,
        base,
        includeUntracked: has("--include-untracked"),
        maxPatchBytes,
        maxFilePatchBytes,
      });
      if (shouldEnforceDetail) enforceDetailProfile(report, requestedDetail, git);

      log("Rendering HTML...");
      const commands = [
        "git status --short",
        "git branch --show-current",
        "git rev-parse --show-toplevel",
        "git rev-parse HEAD",
        mode === "staged" ? "git diff --cached --name-status --numstat" : mode === "baseRef" ? `git diff ${base} --name-status --numstat` : "git diff HEAD --name-status --numstat",
        "snippet content resolved from file path + line ranges; raw diffs intentionally omitted",
      ];
      const html = renderHtml(report, git, commands, template);

      const output = resolveRenderOutput(report, git);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, html, "utf8");
      log(`Wrote ${output}`);

      const shouldOpen = has("--open") || !has("--no-open");
      if (shouldOpen) {
        log("Opening artifact...");
        try {
          openFile(output);
        } catch {
          log("Could not open artifact automatically.");
        }
      }
      if (has("--json")) console.log(JSON.stringify({ artifact: output, files: git.files.length, added: git.totals.added, deleted: git.totals.deleted }));
      else console.log(`Artifact: ${output} (${git.files.length} files)`);
      return;
    }

    usage(1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

function validateTemplate(): ArtifactTemplate {
  const template = arg("--template") || "codebase";
  if (template === "chapters" || template === "sections") fail(`Template ${JSON.stringify(template)} has been removed. Use --template codebase.`);
  if (template !== "codebase") fail(`Unsupported --template ${JSON.stringify(template)}. Supported templates: codebase.`);
  return "codebase";
}

function validateMode(): DiffMode {
  const mode = (arg("--mode") || "worktree") as DiffMode;
  if (!["worktree", "staged", "baseRef"].includes(mode)) fail(`Unsupported --mode ${JSON.stringify(mode)}. Use worktree, staged, or baseRef.`);
  return mode;
}

function validateDetail(defaultMedium: true): ReviewDetail;
function validateDetail(defaultMedium: false): ReviewDetail | undefined;
function validateDetail(defaultMedium: boolean): ReviewDetail | undefined {
  const raw = arg("--detail") || (defaultMedium ? "medium" : undefined);
  return parseReviewDetail(raw);
}

function enforceDetailProfile(report: ReviewReport, requestedDetail?: ReviewDetail, git?: GitSnapshot): void {
  const profile = analyzeDetailProfile({ report, requestedDetail, git });
  if (profile.warnings.length && !has("--json")) {
    console.error("Detail profile warnings:");
    console.error(profile.warnings.map((warning) => `- ${warning}`).join("\n"));
  }
  if (!profile.errors.length) return;
  console.error(`Validation failed: ${profile.detail}-detail profile requirements were not met:`);
  console.error(profile.errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

function resolveRenderOutput(report: ReviewReport, git: GitSnapshot): string {
  const explicitOutput = arg("--output");
  if (explicitOutput) return resolve(explicitOutput);

  const out = arg("--out") || "repo";
  if (out !== "repo" && out !== "localpi" && out !== "global") fail(`Unsupported --out ${JSON.stringify(out)}. Use repo, localpi, or global.`);

  const projectSlug = projectSlugFromCwd(arg("--project-cwd") || process.cwd());
  const outputDir = out === "global" ? join(homedir(), ".pi", "agent", "reviews", projectSlug) : out === "localpi" ? join(git.repoRoot, ".pi", "reviews") : join(git.repoRoot, "html-reviews");
  return resolve(outputDir, `${slug(report.title)}.html`);
}

type DevRenderResult = {
  fixture: string;
  detail: DevRenderDetail;
  artifacts: Array<{ detail: ReviewDetail; path: string }>;
  index?: string;
  openTarget: string;
};

function renderDevFixtures(opts: { fixture: string; detail: DevRenderDetail; template: ArtifactTemplate }): DevRenderResult {
  const details = opts.detail === "all" ? REVIEW_DETAILS : [opts.detail];
  const explicitOutput = arg("--output");
  if (explicitOutput && details.length > 1) fail("dev-render --output is only valid with a single --detail. Use --output-dir for --detail all.");

  const explicitOutputDir = arg("--output-dir");
  const out = validateOutFlag();
  const cwd = resolve(arg("--cwd") || arg("--repo") || arg("--path") || process.cwd());
  const outputDir = explicitOutputDir ? resolve(explicitOutputDir) : defaultDevOutputDir({ cwd, projectCwd: resolve(arg("--project-cwd") || process.cwd()), out });

  const artifacts: Array<{ detail: ReviewDetail; path: string }> = [];
  for (const detail of details) {
    const loaded = loadDevFixture({ fixture: opts.fixture, detail });
    const git = { ...loaded.git, repoRoot: reviewPackageRoot() };
    const html = renderHtml(loaded.report, git, loaded.commands, opts.template);
    const output = explicitOutput ? resolve(explicitOutput) : resolve(outputDir, devArtifactFileName(opts.fixture, detail));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, html, "utf8");
    artifacts.push({ detail, path: output });
    log(`Wrote ${output}`);
  }

  let index: string | undefined;
  if (details.length > 1) {
    index = resolve(outputDir, "index.html");
    mkdirSync(dirname(index), { recursive: true });
    writeFileSync(index, devIndexHtml(opts.fixture, artifacts), "utf8");
    log(`Wrote ${index}`);
  }

  return { fixture: opts.fixture, detail: opts.detail, artifacts, index, openTarget: index || artifacts[0]?.path || outputDir };
}

function validateOutFlag(): "repo" | "localpi" | "global" {
  const out = arg("--out") || "repo";
  if (out !== "repo" && out !== "localpi" && out !== "global") fail(`Unsupported --out ${JSON.stringify(out)}. Use repo, localpi, or global.`);
  return out;
}

function defaultDevOutputDir(opts: { cwd: string; projectCwd: string; out: "repo" | "localpi" | "global" }): string {
  if (opts.out === "global") return join(homedir(), ".pi", "agent", "reviews", projectSlugFromCwd(opts.projectCwd), "dev");
  if (opts.out === "localpi") return join(opts.cwd, ".pi", "reviews", "dev");
  return join(opts.cwd, "html-reviews", "dev");
}

function reviewPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function devArtifactFileName(fixture: string, detail: ReviewDetail): string {
  return `dev-${slug(fixture)}-${detail}.html`;
}

function devIndexHtml(fixture: string, artifacts: Array<{ detail: ReviewDetail; path: string }>): string {
  const links = artifacts
    .map((artifact) => `<li><a href="./${escapeHtml(devArtifactFileName(fixture, artifact.detail))}">${escapeHtml(artifact.detail)} fixture</a></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pi review dev fixtures</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem;line-height:1.5}a{color:#2454d6}code{background:#f1f5f9;padding:.1rem .3rem;border-radius:.25rem}</style>
</head>
<body>
<h1>Pi review dev fixtures</h1>
<p>Static dummy review JSON and GitSnapshot fixtures rendered through the production codebase renderer.</p>
<ul>
${links}
</ul>
</body>
</html>`;
}

function renderOptionsFromFlags(): {
  mode: DiffMode;
  base?: string;
  cwd: string;
  maxPatchBytes: number;
  maxFilePatchBytes: number;
} {
  const mode = validateMode();
  const base = arg("--base");
  if (mode === "baseRef" && !base) fail("--mode baseRef requires --base <ref>.");
  if (mode !== "baseRef" && base) warn("Warning: --base ignored because --mode is not baseRef.");

  return {
    mode,
    base,
    maxPatchBytes: Number(arg("--max-patch-bytes") || 3_000_000),
    maxFilePatchBytes: Number(arg("--max-file-patch-bytes") || 500_000),
    cwd: resolve(arg("--cwd") || process.cwd()),
  };
}

function readInputOrExit(): string {
  if (has("--stdin")) return readFileSync(0, "utf8");
  const inputPath = arg("--input");
  if (!inputPath) {
    console.error("Missing report input: pass --stdin or --input <file>.");
    usage(1);
  }
  return readFileSync(resolve(inputPath), "utf8");
}

function formatValidationError(e: unknown): string {
  const issues = (e as { issues?: Array<{ path?: Array<string | number>; message: string }> }).issues;
  if (issues?.length) {
    return issues.map((issue) => `- ${issue.path?.length ? issue.path.join(".") : "<root>"}: ${issue.message}`).join("\n");
  }
  return e instanceof Error ? e.message : String(e);
}

function scaffoldReport(git: GitSnapshot, detail: ReviewDetail): ReviewReport {
  const firstFiles = git.files.slice(0, Math.min(3, git.files.length));
  return {
    schemaVersion: "2.0",
    artifactKind: "codebase-review",
    reviewDetail: detail,
    title: "TODO_REPLACE: concise subject for the HTML filename, e.g. review-wizard-codebase-map",
    status: {
      currentState: "TODO_REPLACE: explain what the codebase currently does with these changes applied",
      reviewScope: "TODO_REPLACE: define what this artifact covers and what it intentionally does not cover",
      ...(detail === "ultralow" ? {} : { changeSummary: "TODO_REPLACE: summarize the current behavior/configuration changes at a high level" }),
      ...(detail === "high" ? { confidence: "medium" as const } : {}),
    },
    fileMap: git.files.map((file) => ({
      path: file.path,
      changed: true,
      status: file.status,
      role: `TODO_REPLACE: describe what ${file.path} is responsible for in the current codebase`,
      whyRelevant: `TODO_REPLACE: explain why ${file.path} matters to this review`,
    })),
    ...(detail === "ultralow"
      ? {}
      : {
          buildingBlocks: [
            {
              name: "TODO_REPLACE: main codebase building block",
              kind: "module" as const,
              description: "TODO_REPLACE: explain the component/module/concept in current-state terms",
              files: firstFiles.map((file) => file.path),
              snippetIds: [],
            },
          ],
          workflows: [
            {
              name: "TODO_REPLACE: main workflow",
              summary: "TODO_REPLACE: explain how the relevant code path works from start to finish",
              steps: firstFiles.map((file, index) => ({
                label: `TODO_REPLACE: workflow step ${index + 1}`,
                description: `TODO_REPLACE: explain how ${file.path} participates in this workflow`,
                files: [file.path],
                snippetIds: [],
              })),
            },
          ],
          snippets: firstFiles.map((file, index) => ({
            id: `snippet-${index + 1}`,
            path: file.path,
            startLine: 1,
            endLine: 20,
            caption: `TODO_REPLACE: describe the relevant line range in ${file.path}; adjust startLine/endLine to the precise code`,
          })),
        }),
    ...(detail === "medium" || detail === "high"
      ? {
          dataFlows: [
            {
              name: "TODO_REPLACE: relevant data/control flow",
              summary: "TODO_REPLACE: explain what moves through the system",
              nodes: [
                { id: "input", label: "TODO_REPLACE: input/source", kind: "input" as const },
                { id: "process", label: "TODO_REPLACE: processing point", kind: "process" as const },
                { id: "output", label: "TODO_REPLACE: output/result", kind: "output" as const },
              ],
              edges: [
                { from: "input", to: "process", label: "TODO_REPLACE: what is passed" },
                { from: "process", to: "output", label: "TODO_REPLACE: what is produced" },
              ],
            },
          ],
          reviewFocus: [
            {
              area: "TODO_REPLACE: review area",
              question: "TODO_REPLACE: key human review question",
              severity: "medium" as const,
              files: firstFiles.map((file) => file.path),
              snippetIds: [],
            },
          ],
        }
      : {}),
    ...(detail === "high"
      ? {
          risks: [
            {
              severity: "medium" as const,
              area: "TODO_REPLACE: risk area or replace with explicit low/no-risk callout",
              description: "TODO_REPLACE: describe a meaningful risk",
              mitigation: "TODO_REPLACE: describe mitigation or remove mitigation",
              files: firstFiles.map((file) => file.path),
              snippetIds: [],
            },
          ],
          decisions: [
            {
              decision: "TODO_REPLACE: important implementation decision or explicit no-notable-decisions entry",
              rationale: "TODO_REPLACE: why this decision was made",
              alternatives: ["TODO_REPLACE: alternative considered or remove alternatives"],
              files: firstFiles.map((file) => file.path),
            },
          ],
          knownLimitations: ["TODO_REPLACE: known limitation or explicit none entry"],
        }
      : {}),
    ...(detail === "ultralow"
      ? {}
      : {
          validation: {
            runs: [
              {
                name: "TODO_REPLACE: validation command or check name",
                command: "TODO_REPLACE: command run, or remove command if not applicable",
                result: "not_run" as const,
                notes: "TODO_REPLACE: update result/evidence for checks run, or move to missingValidation",
              },
            ],
          },
          missingValidation: ["TODO_REPLACE: list important checks not run, or replace with an empty array if none are missing"],
        }),
  };
}

function findPlaceholders(value: unknown, path = "$", found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/TODO_REPLACE/i.test(value)) found.push(`${path}: ${value}`);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`, found));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) findPlaceholders(child, `${path}.${key}`, found);
  }
  return found;
}

function guideText(): string {
  return `# pi-review-artifact codebase guide

Use scaffold -> fill -> validate -> render. Do not paste HTML, raw diffs, or copied code into the JSON. The report should explain how the current code works and should reference code snippets by file path and line range.

Required workflow:
1. Run scaffold with the requested --cwd, --mode, --include-untracked, and --detail flags.
2. Inspect the changed files and relevant adjacent files. Use targeted file reads to identify precise line ranges.
3. Fill the scaffold JSON, replacing every TODO_REPLACE placeholder. Use snippet references such as {"path":"src/file.ts","startLine":10,"endLine":30}; the CLI reads snippet text from disk at render time.
4. Validate with the same --cwd/--mode/--include-untracked/--detail flags. This checks schema, changed-file coverage, snippet references, and tier budgets.
5. Render with --template codebase. Return the Artifact path plus a concise reviewer summary.

Useful commands:
  node /absolute/path/to/dist/bin/pi-review-artifact.js scaffold --template codebase --cwd /repo --mode worktree --include-untracked --detail medium --output /tmp/review-report.json
  node /absolute/path/to/dist/bin/pi-review-artifact.js render --input /tmp/review-report.json --template codebase --cwd /repo --mode worktree --include-untracked --detail medium --out repo --no-open

Detail tiers:
- ultralow: status + file map, optional explanatory block/flow, 0-3 snippets, max about 80 snippet lines.
- low: compact codebase map, at least one workflow/block/data flow, 1-6 snippets, validation or missingValidation.
- medium: default shareable artifact, full changed-file map, building blocks, workflow/data flow, 2-12 snippets, validation and review focus.
- high: rigorous artifact, broader context, multiple focus/risk/decision sections, 4-25 snippets, validation evidence and limitations.

Rules:
- Raw diffs are intentionally omitted; GitHub already provides diffs.
- Do not include inline code in JSON. Include only snippet ids, paths, startLine/endLine, captions, and optional highlights/mustContain anchors.
- Prefer short, purposeful snippets over large ranges.
- Include important unchanged adjacent files in fileMap with changed:false when needed to explain behavior.
- Do not invent test results. Use missingValidation for checks not run.
- Files marked changed:true should match final git metadata. The renderer warns about stale or missing paths.
`;
}

function exampleReport(): ReviewReport {
  return {
    schemaVersion: "2.0",
    artifactKind: "codebase-review",
    reviewDetail: "medium",
    title: "Review artifact example",
    status: {
      currentState: "The review extension collects UI choices, sends an agent prompt, and renders structured JSON into an HTML codebase map.",
      reviewScope: "This example covers the prompt construction and renderer handoff path.",
      changeSummary: "The artifact format explains current code responsibilities and workflows instead of reproducing raw diffs.",
      confidence: "medium",
    },
    fileMap: [
      {
        path: "index.ts",
        changed: true,
        role: "Registers /pr and builds the prompt that asks the agent for codebase-review JSON.",
        whyRelevant: "This is the user-facing entrypoint for the workflow.",
        responsibilities: ["wizard option collection", "prompt construction", "handoff to the agent"],
        snippetIds: ["prompt-builder"],
      },
      {
        path: "src/render.ts",
        changed: true,
        role: "Orchestrates JSON-to-HTML rendering and snippet resolution.",
        whyRelevant: "This is where structured report data becomes the final artifact.",
        responsibilities: ["validate template", "resolve snippets", "compose HTML"],
      },
    ],
    buildingBlocks: [
      {
        name: "Prompt-to-render contract",
        kind: "workflow",
        description: "The UI collects flags; the agent emits compact JSON with snippet line ranges; the CLI reads the snippets locally and renders HTML.",
        files: ["index.ts", "src/render.ts"],
        inputs: ["wizard options", "agent-authored JSON"],
        outputs: ["self-contained HTML artifact"],
        snippetIds: ["prompt-builder"],
      },
    ],
    workflows: [
      {
        name: "Review artifact generation",
        summary: "A top-down flow from /pr invocation to HTML output.",
        steps: [
          { label: "Pick options", description: "The user chooses target, detail, output, and open behavior in the UI.", files: ["index.ts"] },
          { label: "Generate JSON", description: "The agent inspects the code and writes codebase-review JSON with snippet references.", files: ["index.ts"], snippetIds: ["prompt-builder"] },
          { label: "Render artifact", description: "The CLI validates JSON, resolves snippet line ranges, and writes HTML.", files: ["src/render.ts"] },
        ],
      },
    ],
    dataFlows: [
      {
        name: "Options to artifact",
        summary: "The artifact is built from UI options, model-generated structure, local file snippets, and git metadata.",
        nodes: [
          { id: "ui", label: "/pr wizard", kind: "input", files: ["index.ts"] },
          { id: "agent", label: "Agent JSON", kind: "process" },
          { id: "cli", label: "CLI renderer", kind: "process", files: ["src/render.ts"] },
          { id: "html", label: "HTML artifact", kind: "output" },
        ],
        edges: [
          { from: "ui", to: "agent", label: "prompt + flags" },
          { from: "agent", to: "cli", label: "structured JSON" },
          { from: "cli", to: "html", label: "rendered output" },
        ],
      },
    ],
    snippets: [
      {
        id: "prompt-builder",
        path: "index.ts",
        startLine: 1,
        endLine: 30,
        caption: "Example snippet reference. Real reports should point at the precise relevant lines.",
      },
      {
        id: "render-entry",
        path: "src/render.ts",
        startLine: 1,
        endLine: 18,
        caption: "Example renderer entrypoint snippet reference.",
      },
    ],
    reviewFocus: [
      {
        area: "Prompt contract",
        question: "Does the prompt clearly forbid raw diffs and require snippet line-range references?",
        severity: "medium",
        files: ["index.ts"],
        snippetIds: ["prompt-builder"],
      },
    ],
    validation: {
      runs: [{ name: "TypeScript", command: "npm run typecheck", result: "not_run", notes: "Example report only." }],
    },
    missingValidation: ["No real project tests were run for this example."],
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "review";
}

function projectSlugFromCwd(cwd: string): string {
  return slug(basename(resolve(cwd)) || resolve(cwd));
}

main();
