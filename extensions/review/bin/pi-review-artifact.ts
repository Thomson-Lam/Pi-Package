#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { validateReport, reportJsonSchema } from "../src/schema.js";
import type { ReviewDetail, ReviewReport } from "../src/schema.js";
import { collectGitSnapshot } from "../src/git.js";
import type { DiffMode, GitFileDiff, GitSnapshot } from "../src/git.js";
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
  guide [--template chapters]
  example [--template chapters]
  schema --json
  dev-render [--template chapters] [--fixture comprehensive] [--detail ultralow|low|medium|high|all] [--cwd <path>] [--out repo|localpi|global] [--output <file>] [--output-dir <dir>] [--open|--no-open] [--json]
  scaffold [--template chapters] [--cwd <repo>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--output <file>] [--json]
  validate --stdin|--input <file> [--template chapters] [--cwd <repo>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--json]
  render --stdin|--input <file> [--template chapters] [--output <file>] [--out repo|localpi|global] [--cwd <repo>] [--mode worktree|staged|baseRef] [--base <ref>] [--include-untracked] [--detail ultralow|low|medium|high] [--open|--no-open] [--json]

Notes:
  - The only supported artifact template is "chapters".
  - baseRef mode requires --base <ref>.
  - dev-render uses static dummy JSON and git fixtures; it does not inspect real git or invoke an agent.
  - scaffold writes a TODO_REPLACE draft; validate/render reject unresolved placeholders.
  - render and dev-render default to --out repo and open the artifact unless --no-open is passed.

Run "pi-review-artifact --help" for examples and detail-tier behavior.`;
}

function cliHelpText(): string {
  return `${shortUsage()}

Workflow:
  1. For low/ultralow, generate compact JSON and pass it directly to render --stdin.
  2. For medium/high, scaffold creates a JSON draft from the current git diff.
  3. An agent or human replaces every TODO_REPLACE placeholder.
  4. render validates schema/placeholders/detail coverage, collects authoritative git metadata/diffs, and writes self-contained HTML.
  5. validate remains available for manual debugging and smoke checks.

Examples:
  node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --cwd . --out localpi --no-open
  node dist/bin/pi-review-artifact.js scaffold --cwd . --mode worktree --include-untracked --detail medium --output /tmp/review.json
  node dist/bin/pi-review-artifact.js render --input /tmp/review.json --template chapters --cwd . --mode worktree --include-untracked --detail medium --out repo --no-open
  node dist/bin/pi-review-artifact.js render --stdin --template chapters --cwd . --mode worktree --include-untracked --detail low --out localpi --no-open < /tmp/low-review.json

Detail tiers:
  ultralow  Fastest compact handoff. One broad grouping, minimal fields, raw diffs omitted from the artifact.
  low       Compact internal handoff. 1-3 broad chapters, file purposes, validation or missingValidation.
  medium    Default shareable artifact. Explicit chapters, all changed files assigned, chapter intent/focus, validation.
  high      Rigorous review. Exact file coverage, per-file focus, chapter risks/validation, top-level risks/decisions/limitations.

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
      log("Collecting diff patch...");
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
        mode === "staged" ? "git diff --cached ..." : mode === "baseRef" ? `git diff ${base} ...` : "git diff HEAD ...",
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
  const template = arg("--template") || "chapters";
  if (template === "sections") fail('Template "sections" has been removed. Use --template chapters and put old changes/files content into chapters.');
  if (template !== "chapters") fail(`Unsupported --template ${JSON.stringify(template)}. Supported templates: chapters.`);
  return "chapters";
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

  const outputDir = out === "global" ? join(homedir(), ".pi", "agent", "reviews") : out === "localpi" ? join(git.repoRoot, ".pi", "reviews") : git.repoRoot;
  return resolve(outputDir, `${new Date().toISOString().replace(/[.:]/g, "-")}-${slug(report.title)}.html`);
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
  const outputDir = explicitOutputDir ? resolve(explicitOutputDir) : defaultDevOutputDir({ cwd, out, multiple: details.length > 1 });

  const artifacts: Array<{ detail: ReviewDetail; path: string }> = [];
  for (const detail of details) {
    const loaded = loadDevFixture({ fixture: opts.fixture, detail });
    const html = renderHtml(loaded.report, loaded.git, loaded.commands, opts.template);
    const output = explicitOutput ? resolve(explicitOutput) : details.length === 1 && !explicitOutputDir && out === "repo" ? resolve(cwd, devArtifactFileName(opts.fixture, detail)) : resolve(outputDir, devArtifactFileName(opts.fixture, detail));
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

function defaultDevOutputDir(opts: { cwd: string; out: "repo" | "localpi" | "global"; multiple: boolean }): string {
  if (opts.out === "global") return join(homedir(), ".pi", "agent", "reviews", "dev");
  if (opts.out === "localpi") return join(opts.cwd, ".pi", "reviews", "dev");
  return opts.multiple ? join(opts.cwd, "pi-review-dev") : opts.cwd;
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
<p>Static dummy review JSON and GitSnapshot fixtures rendered through the production chapters renderer.</p>
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
  const groups = groupFiles(git.files, detail);
  return {
    schemaVersion: "1.0",
    reviewDetail: detail,
    title: "TODO_REPLACE: concise review artifact title",
    summary: {
      intent: "TODO_REPLACE: summarize the purpose of the final diff for reviewers",
      changeType: "mixed",
      ...(detail === "ultralow" || detail === "low" ? {} : { howItWorks: "TODO_REPLACE: briefly explain how the changed pieces work together" }),
    },
    changes: groups.map((group) => ({
      title: group.title,
      summary: "TODO_REPLACE: summarize this change group",
      files: group.files.map((file) => ({
        path: file.path,
        purpose: `TODO_REPLACE: explain why ${file.path} changed`,
      })),
      ...(detail === "ultralow" || detail === "low" ? {} : { reviewerNotes: ["TODO_REPLACE: add reviewer guidance for this group or remove this note"] }),
    })),
    chapters: groups.map((group, index) => ({
      sequence: index + 1,
      title: group.title,
      summary: "TODO_REPLACE: summarize this review chapter",
      ...(detail === "ultralow" || detail === "low" ? {} : { intent: "TODO_REPLACE: state what reviewers should understand before reading these diffs" }),
      files: group.files.map((file) => ({
        path: file.path,
        purpose: `TODO_REPLACE: explain this file's role in the chapter`,
        ...(detail === "high"
          ? {
              reviewFocus: ["TODO_REPLACE: add file-specific review focus/risk guidance or remove this field"],
            }
          : {}),
      })),
      ...(detail === "ultralow" || detail === "low"
        ? {}
        : {
            reviewFocus:
              detail === "high"
                ? ["TODO_REPLACE: add primary chapter-level review focus", "TODO_REPLACE: add secondary chapter-level review focus"]
                : ["TODO_REPLACE: add chapter-level review focus"],
          }),
      ...(detail === "high"
        ? {
            risks: ["TODO_REPLACE: add chapter-specific risk or remove this field"],
            validation: ["TODO_REPLACE: add chapter-specific validation note or remove this field"],
          }
        : {}),
    })),
    ...(detail === "high"
      ? {
          behaviorFlow: [
            {
              label: "TODO_REPLACE: behavior step label or remove behaviorFlow",
              description: "TODO_REPLACE: describe behavior flow only if behavior changed",
              files: git.files.slice(0, 3).map((file) => file.path),
            },
          ],
          risks: [
            {
              severity: "medium" as const,
              area: "TODO_REPLACE: risk area or remove risks",
              description: "TODO_REPLACE: describe a meaningful risk",
              mitigation: "TODO_REPLACE: describe mitigation or remove mitigation",
              files: git.files.slice(0, 3).map((file) => file.path),
            },
          ],
          decisions: [
            {
              decision: "TODO_REPLACE: important implementation decision or remove decisions",
              rationale: "TODO_REPLACE: why this decision was made",
              alternatives: ["TODO_REPLACE: alternative considered or remove alternatives"],
            },
          ],
          knownLimitations: ["TODO_REPLACE: known limitation or remove knownLimitations"],
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
          missingValidation: ["TODO_REPLACE: list important checks not run, or replace with an empty array if none"],
        }),
  };
}

function groupFiles(files: GitFileDiff[], detail: ReviewDetail): Array<{ title: string; files: GitFileDiff[] }> {
  if (detail === "ultralow" || detail === "low") return [{ title: "Review target changes", files }];
  const groups = new Map<string, GitFileDiff[]>();
  for (const file of files) {
    const key = groupKey(file.path, detail);
    const existing = groups.get(key) || [];
    existing.push(file);
    groups.set(key, existing);
  }
  return Array.from(groups.entries()).map(([key, groupFiles]) => ({ title: titleForGroup(key), files: groupFiles }));
}

function groupKey(path: string, detail: ReviewDetail): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  if (detail === "high" && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts.length === 1 ? "root" : parts[0];
}

function titleForGroup(key: string): string {
  if (key === "root") return "Root-level files";
  return `${key} changes`;
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
  return `# pi-review-artifact chapters guide

Use scaffold -> fill -> validate -> render. Do not paste HTML or raw diffs into the JSON; the CLI reads authoritative git metadata and patches.

Required workflow:
1. Run scaffold with the requested --cwd, --mode, --include-untracked, and --detail flags.
2. Inspect the final diff and decide a logical reviewer order.
3. Fill the scaffold JSON, replacing every TODO_REPLACE placeholder.
4. Validate with the same --cwd/--mode/--include-untracked/--detail flags. This runs tier-specific structural and diff coverage checks.
5. Render with --template chapters, the requested diff mode, and --detail. Return the Artifact path plus a concise reviewer summary.

Useful commands:
  node /absolute/path/to/dist/bin/pi-review-artifact.js scaffold --template chapters --cwd /repo --mode worktree --include-untracked --detail medium --output /tmp/review-report.json
  node /absolute/path/to/dist/bin/pi-review-artifact.js render --input /tmp/review-report.json --template chapters --cwd /repo --mode worktree --include-untracked --detail medium --out repo --no-open

Detail tiers:
- ultralow: fastest compact handoff; one broad grouping; minimal fields; rendered artifact omits raw diffs.
- low: compact internal handoff; 1-3 broad chapters; each file needs purpose; requires validation run(s) or missingValidation note(s).
- medium: default shareable artifact; explicit chapters; all changed files assigned; chapter intent/reviewFocus; validation and missingValidation fields.
- high: rigorous review; explicit chapters; every changed file assigned exactly once; per-file reviewFocus; chapter risks/validation; top-level risks, decisions, limitations, and validation evidence.

Rules:
- Escape nothing manually; provide plain JSON strings.
- Do not invent test results. Use missingValidation for checks not run.
- Use high risk for auth, permissions, migrations, payments, data deletion, shared middleware, schemas, and out-of-scope changes.
- Files in chapters should match final git diff paths. The renderer warns about stale or invented paths.
`;
}

function exampleReport(): ReviewReport {
  return {
    schemaVersion: "1.0",
    reviewDetail: "medium",
    title: "Review artifact example",
    summary: {
      intent: "Show the minimal chapters template shape for a final worktree review.",
      changeType: "mixed",
      howItWorks: "The report groups files into a reviewer-friendly sequence; the CLI supplies git metadata and diffs.",
    },
    changes: [
      {
        title: "Command workflow",
        summary: "Adds the user-facing review command and CLI invocation path.",
        risk: "low",
        reviewerNotes: ["Check that command defaults match the intended review target."],
        files: [{ path: "index.ts", purpose: "Registers /pr and sends the agent workflow prompt.", risk: "low" }],
      },
    ],
    chapters: [
      {
        sequence: 1,
        title: "Command workflow",
        summary: "Review the command entrypoint before renderer details.",
        intent: "Confirm the extension starts the review workflow without skill discovery.",
        files: [
          {
            path: "index.ts",
            purpose: "Registers /pr and sends exact CLI commands.",
            reviewFocus: ["Argument parsing", "Absolute CLI path", "Open/include-untracked defaults"],
            risk: "low",
          },
        ],
        reviewFocus: ["The agent can follow the prompt without reading source."],
        risks: ["Incorrect cwd or CLI path would break artifact generation."],
        validation: ["Run /reload then /pr in Pi."],
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

main();
