import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSnapshot } from "./git.js";
import { validateReport } from "./schema.js";
import type { ReviewDetail, ReviewReport } from "./schema.js";

export type DevFixtureName = "comprehensive";
export type DevRenderDetail = ReviewDetail | "all";

export const REVIEW_DETAILS: ReviewDetail[] = ["ultralow", "low", "medium", "high"];
export const DEV_FIXTURES: DevFixtureName[] = ["comprehensive"];

export type LoadedDevFixture = {
  report: ReviewReport;
  git: GitSnapshot;
  commands: string[];
};

export function parseDevRenderDetail(value: string | undefined, defaultValue: DevRenderDetail = "all"): DevRenderDetail {
  const raw = value || defaultValue;
  if (raw === "all" || raw === "ultralow" || raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`Unsupported --detail ${JSON.stringify(raw)}. Use ultralow, low, medium, high, or all.`);
}

export function parseDevFixtureName(value: string | undefined): DevFixtureName {
  const raw = value || "comprehensive";
  if ((DEV_FIXTURES as string[]).includes(raw)) return raw as DevFixtureName;
  throw new Error(`Unsupported --fixture ${JSON.stringify(raw)}. Available fixtures: ${DEV_FIXTURES.join(", ")}.`);
}

export function loadDevFixture(opts: { fixture?: string; detail: ReviewDetail }): LoadedDevFixture {
  const fixture = parseDevFixtureName(opts.fixture);
  const dir = devFixtureDir();
  const report = validateReport(readJson(resolve(dir, `${fixture}.${opts.detail}.json`)));
  const git = validateGitFixture(readJson(resolve(dir, `${fixture}.git.json`)));
  return {
    report,
    git,
    commands: devFixtureCommands(fixture, opts.detail),
  };
}

function devFixtureDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/dev");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateGitFixture(value: unknown): GitSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid dev git fixture: expected object.");
  const git = value as Partial<GitSnapshot>;
  if (typeof git.repoRoot !== "string") throw new Error("Invalid dev git fixture: missing repoRoot.");
  if (typeof git.branch !== "string") throw new Error("Invalid dev git fixture: missing branch.");
  if (typeof git.headSha !== "string") throw new Error("Invalid dev git fixture: missing headSha.");
  if (typeof git.baseLabel !== "string") throw new Error("Invalid dev git fixture: missing baseLabel.");
  if (git.mode !== "worktree" && git.mode !== "staged" && git.mode !== "baseRef") throw new Error("Invalid dev git fixture: unsupported mode.");
  if (!git.totals || typeof git.totals.files !== "number" || typeof git.totals.added !== "number" || typeof git.totals.deleted !== "number") {
    throw new Error("Invalid dev git fixture: missing numeric totals.");
  }
  if (!Array.isArray(git.files)) throw new Error("Invalid dev git fixture: files must be an array.");
  for (const [index, file] of git.files.entries()) {
    if (!file || typeof file !== "object") throw new Error(`Invalid dev git fixture: files[${index}] must be an object.`);
    const candidate = file as Record<string, unknown>;
    if (typeof candidate.path !== "string" || typeof candidate.status !== "string") throw new Error(`Invalid dev git fixture: files[${index}] missing path/status.`);
    if (typeof candidate.added !== "number" || typeof candidate.deleted !== "number") throw new Error(`Invalid dev git fixture: files[${index}] missing numeric delta.`);
  }
  return git as GitSnapshot;
}

function devFixtureCommands(fixture: DevFixtureName, detail: ReviewDetail): string[] {
  return [
    `dev-render --fixture ${fixture} --detail ${detail}`,
    "git status --short  # fixture: not executed",
    "git diff HEAD --stat  # fixture: not executed",
    "git diff HEAD --name-status --numstat --find-renames  # fixture: not executed",
    "snippet content resolved from file path + line ranges; raw diffs omitted",
    "node dist/bin/pi-review-artifact.js dev-render --fixture comprehensive --detail all --no-open",
  ];
}
