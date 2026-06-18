import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { CONFIG_PATH, PLAN_MODE_DIR, PLANS_DIR, SUMODULES_DIR } from "./constants.js";
import type { PlanDescriptor, PlanLocation, PlanModeConfig, PlanStoreMode } from "./types.js";

export interface PlanStoreOptions {
  mode?: PlanStoreMode;
  cwd?: string;
}

function sanitizeName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/\.md$/i, "").replace(/\s+/g, "-");
  if (!normalized) throw new Error("Name is required");
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new Error("Names may only contain letters, numbers, ., _, and -");
  }
  return normalized;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function directoryExists(dir: string): boolean {
  try {
    return fsSync.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function getRepoRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (directoryExists(path.join(current, ".git")) || fsSync.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function getPlanModeRoot(options: PlanStoreOptions = {}): string {
  if (options.mode === "repo") return path.join(getRepoRoot(options.cwd ?? process.cwd()), ".pi", "plan-mode");
  return PLAN_MODE_DIR;
}

export function getPlansDir(options: PlanStoreOptions = {}): string {
  if (options.mode === "repo") return path.join(getPlanModeRoot(options), "plans");
  return PLANS_DIR;
}

export function getSuModulesDir(options: PlanStoreOptions = {}): string {
  if (options.mode === "repo") return path.join(getPlanModeRoot(options), "sumodules");
  return SUMODULES_DIR;
}

export function getConfigPath(options: PlanStoreOptions = {}): string {
  if (options.mode === "repo") return path.join(getPlanModeRoot(options), "config.json");
  return CONFIG_PATH;
}

export async function ensurePlanModeLayout(options: PlanStoreOptions = {}): Promise<void> {
  const root = getPlanModeRoot(options);
  const plansDir = getPlansDir(options);
  const suModulesDir = getSuModulesDir(options);
  const configPath = getConfigPath(options);

  await ensureDir(root);
  await ensureDir(plansDir);
  await ensureDir(suModulesDir);

  try {
    await fs.access(configPath);
  } catch {
    const config: PlanModeConfig = { recentPlans: [], planLocations: {} };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
}

export function normalizePlanName(name: string): string {
  return sanitizeName(name);
}

export function normalizeSuModuleName(name: string): string {
  return sanitizeName(name);
}

export function isPlanPathArg(arg: string): boolean {
  const trimmed = arg.trim();
  return trimmed.includes("/") || trimmed.includes("\\") || trimmed.toLowerCase().endsWith(".md");
}

export function derivePlanNameFromPathArg(arg: string): string {
  const base = path.basename(arg.trim()).replace(/\.md$/i, "");
  return normalizePlanName(base);
}

export function resolveRepoRelativePath(arg: string, cwd: string): string {
  const repoRoot = getRepoRoot(cwd);
  const requested = arg.trim();
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(repoRoot, requested);
  const rel = path.relative(repoRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Plan path must stay inside repo root (${repoRoot}): ${arg}`);
  }
  if (!resolved.toLowerCase().endsWith(".md")) throw new Error("Explicit plan paths must end with .md");
  return resolved;
}

export function getPlanPath(name: string, options: PlanStoreOptions = {}): string {
  return path.join(getPlansDir(options), `${normalizePlanName(name)}.md`);
}

export function getSuModulePath(name: string, options: PlanStoreOptions = {}): string {
  return path.join(getSuModulesDir(options), `${normalizeSuModuleName(name)}.md`);
}

export function resolveKnownPlanPath(name: string, knownLocations?: Record<string, PlanLocation>): string | undefined {
  const normalized = normalizePlanName(name);
  return knownLocations?.[normalized]?.path;
}

export async function resolvePlanFilePath(
  name: string,
  options: PlanStoreOptions = {},
  knownLocations?: Record<string, PlanLocation>,
): Promise<string> {
  const known = resolveKnownPlanPath(name, knownLocations);
  if (known) return known;

  const config = await readConfig(options);
  const normalized = normalizePlanName(name);
  return config.planLocations[normalized]?.path ?? getPlanPath(normalized, options);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function createPlan(name: string, options: PlanStoreOptions = {}): Promise<string> {
  await ensurePlanModeLayout(options);
  const planName = normalizePlanName(name);
  const planPath = getPlanPath(planName, options);
  if (await fileExists(planPath)) throw new Error(`Plan already exists: ${planName}`);
  const content = `# ${planName}\n\n## Goal\n\n## Context\n\n## Plan\n\n## Open Questions\n`;
  await fs.writeFile(planPath, content, "utf8");
  await registerPlanLocation(planName, planPath, "store", options);
  return planPath;
}

export async function createPlanAtPath(arg: string, options: PlanStoreOptions & { cwd: string }): Promise<{ name: string; path: string }> {
  await ensurePlanModeLayout(options);
  const planName = derivePlanNameFromPathArg(arg);
  const planPath = resolveRepoRelativePath(arg, options.cwd);
  if (await fileExists(planPath)) throw new Error(`Plan already exists: ${planPath}`);
  await ensureDir(path.dirname(planPath));
  const content = `# ${planName}\n\n## Goal\n\n## Context\n\n## Plan\n\n## Open Questions\n`;
  await fs.writeFile(planPath, content, "utf8");
  await registerPlanLocation(planName, planPath, "explicitPath", options);
  return { name: planName, path: planPath };
}

export async function createSuModule(name: string, options: PlanStoreOptions = {}): Promise<string> {
  await ensurePlanModeLayout(options);
  const suModuleName = normalizeSuModuleName(name);
  const suModulePath = getSuModulePath(suModuleName, options);
  if (await fileExists(suModulePath)) throw new Error(`SuModule already exists: ${suModuleName}`);
  const content = `# ${suModuleName}\n\n- Criterion:\n- Signals:\n- Gaps to check:\n`;
  await fs.writeFile(suModulePath, content, "utf8");
  return suModulePath;
}

async function listMarkdownFiles(dir: string): Promise<PlanDescriptor[]> {
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = await fs.stat(fullPath);
        return {
          name: entry.name.slice(0, -3),
          path: fullPath,
          mtimeMs: stat.mtimeMs,
        } satisfies PlanDescriptor;
      }),
  );
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

async function descriptorsForLocations(locations: Record<string, PlanLocation>): Promise<PlanDescriptor[]> {
  const descriptors: PlanDescriptor[] = [];
  for (const location of Object.values(locations)) {
    try {
      const stat = await fs.stat(location.path);
      descriptors.push({ name: location.name, path: location.path, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore missing explicit locations in list views.
    }
  }
  return descriptors;
}

export async function listPlans(
  options: PlanStoreOptions = {},
  knownLocations?: Record<string, PlanLocation>,
): Promise<PlanDescriptor[]> {
  await ensurePlanModeLayout(options);
  const config = await readConfig(options);
  const storePlans = await listMarkdownFiles(getPlansDir(options));
  const explicitPlans = await descriptorsForLocations({ ...config.planLocations, ...(knownLocations ?? {}) });
  const byName = new Map<string, PlanDescriptor>();
  for (const plan of [...storePlans, ...explicitPlans]) byName.set(plan.name, plan);
  return [...byName.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

export async function listSuModules(options: PlanStoreOptions = {}): Promise<PlanDescriptor[]> {
  await ensurePlanModeLayout(options);
  return listMarkdownFiles(getSuModulesDir(options));
}

export async function readConfig(options: PlanStoreOptions = {}): Promise<PlanModeConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(options), "utf8");
    const parsed = JSON.parse(raw) as Partial<PlanModeConfig>;
    return { recentPlans: parsed.recentPlans ?? [], planLocations: parsed.planLocations ?? {} };
  } catch {
    return { recentPlans: [], planLocations: {} };
  }
}

export async function writeConfig(config: PlanModeConfig, options: PlanStoreOptions = {}): Promise<void> {
  await ensurePlanModeLayout(options);
  await fs.writeFile(getConfigPath(options), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export async function registerPlanLocation(
  name: string,
  planPath: string,
  kind: PlanLocation["kind"],
  options: PlanStoreOptions = {},
): Promise<PlanLocation> {
  const normalized = normalizePlanName(name);
  const config = await readConfig(options);
  const previous = config.planLocations[normalized];
  const now = Date.now();
  const location: PlanLocation = {
    name: normalized,
    path: path.resolve(planPath),
    kind,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  config.planLocations[normalized] = location;
  await writeConfig(config, options);
  return location;
}

export async function removePlanLocation(name: string, options: PlanStoreOptions = {}): Promise<void> {
  const normalized = normalizePlanName(name);
  const config = await readConfig(options);
  delete config.planLocations[normalized];
  await writeConfig(config, options);
}

export async function touchRecentPlan(name: string, options: PlanStoreOptions = {}): Promise<void> {
  const normalized = normalizePlanName(name);
  const config = await readConfig(options);
  config.recentPlans = [normalized, ...config.recentPlans.filter((item) => item !== normalized)].slice(0, 20);
  await writeConfig(config, options);
}

export async function resolveDefaultPlanName(
  currentPlanName?: string,
  options: PlanStoreOptions = {},
  knownLocations?: Record<string, PlanLocation>,
): Promise<string | undefined> {
  if (currentPlanName) return normalizePlanName(currentPlanName);
  const plans = await listPlans(options, knownLocations);
  if (plans.length > 0) return plans[0].name;
  const config = await readConfig(options);
  return config.recentPlans[0];
}
