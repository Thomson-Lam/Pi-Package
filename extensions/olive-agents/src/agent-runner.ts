/**
 * agent-runner.ts — Launch-spec preparation for child agent Pi sessions.
 *
 * The parent prepares everything the child needs to boot a native Pi
 * InteractiveMode over a persistent agent session (see REVIEW-UX-SPEC.md):
 * system prompt, tool allowlist, extension path list, model/thinking, session
 * identity and mailbox wiring. The child host (child-host.mjs) consumes the
 * serialized spec; it performs no independent configuration discovery.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  getPackageDir,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { buildParentContext } from "./context.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import { agentSessionName } from "./names.js";
import type { DeliveredContextHandoff } from "./handoff/serialize.js";
import type { AgentLaunchSpec, SubagentType, ThinkingLevel } from "./types.js";
import { writeJsonAtomic } from "./event-mailbox.js";

// Re-export for callers that historically imported the spec from agent-runner.
export type { AgentLaunchSpec } from "./types.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the child exclusion list below can't
 * drift apart.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that child agents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package. See the original implementation notes in the pre-refactor
 * agent-runner.ts (climbs to the owning package root, respects node_modules
 * boundaries, verifies the manifest lists the entry).
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
      continue;
    }
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/** All names an extension answers to for allowlist matching (lowercased). */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 * Path entries are resolved to absolute paths; names are matched by canonical name.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") { wildcard = true; continue; }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = `${process.env.HOME ?? ""}${p.slice(1)}`;
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) { set = new Set(); narrowing.set(name, set); }
    set.add(tool);
  }
  return { extNames, narrowing };
}

// ---- Launch specification ----

export interface PrepareLaunchInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  description: string;
  options: {
    model: Model<any>;
    thinking?: ThinkingLevel;
    maxTurns?: number;
    isolated: boolean;
    inheritContext: boolean;
    /** Worktree (or custom) working directory for the child. */
    cwd?: string;
    /** Parent config cwd when a custom cwd is in play. */
    configCwd?: string;
    /** Approved constrained-context packet (immutable, already serialized). */
    handoff?: DeliveredContextHandoff;
  };
  agentId: string;
  childSessionId: string;
  parentSessionFile?: string;
  sessionDir?: string;
  mailboxDir: string;
}

export interface PrepareLaunchResult {
  spec: AgentLaunchSpec;
  warnings: string[];
}

/**
 * Prepare the full launch specification for a child agent session. Runs the
 * same extension/tool resolution the old in-process runner did, but produces
 * data for the child host instead of a live session. Collects diagnostics as
 * warnings (returned, not thrown) so the caller can surface them.
 */
export async function prepareAgentLaunch(input: PrepareLaunchInput): Promise<PrepareLaunchResult> {
  const { pi, ctx, type, prompt, options } = input;
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);
  const warnings: string[] = [];

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(pi, effectiveCwd);
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};
  const extensions = options.isolated ? false : config.extensions;
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const skills = options.isolated ? false : config.skills;

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) extras.skillBlocks = loaded;
  }

  let toolNames = getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");
    if (hasWriteTools) {
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: build a generic prompt from the canonical config.
    const fallback = {
      name: type,
      displayName: config.displayName,
      description: config.description,
      builtinToolNames: config.builtinToolNames,
      extensions: config.extensions,
      skills: config.skills,
      promptMode: config.promptMode,
      systemPrompt: "",
      isDefault: false,
    };
    systemPrompt = buildAgentPrompt(fallback, effectiveCwd, env, parentSystemPrompt, extras);
  }

  const noSkills = skills === false || Array.isArray(skills);

  // ---- Extension resolution (runs in the parent so the child needs no
  // discovery logic beyond loading the final path list) ----
  const { extNames, narrowing } = parseExtSelectors(
    options.isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;
  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;

  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false;
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir: getAgentDir(),
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: false, // the child runs a real TUI — themes must load
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Built-in tool name validation (typos in `tools:`).
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        warnings.push(`tool "${name}" requested by agent "${type}" is not a known built-in`);
      }
    }
  }

  // Extension diagnostics (typos, excludes without effect, etc.).
  if (hasExcludes && noExtensions) {
    warnings.push(`exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`);
  }
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        warnings.push(`exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`);
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        warnings.push(excludeNames.has(name)
          ? `extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
          : `extension "${name}" requested by agent "${type}" was not loaded`);
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        warnings.push(`ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`);
      }
    }
  }

  // Enumerate extension-registered tool names from the loaded loader.
  const extensionToolNames: string[] = [];
  if (!noExtensions) {
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const toolName of extension.tools.keys()) {
        if (narrowed && !narrowed.has(toolName)) continue;
        extensionToolNames.push(toolName);
      }
    }
  }

  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (agentConfig?.disallowedTools?.includes(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    return !noExtensions;
  });

  const finalExtensionPaths = loader.getExtensions().extensions.map((e) => e.path);

  // Effective prompt: optionally prepend parent context.
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) effectivePrompt = parentContext + prompt;
  }

  const config2 = getConfig(type);
  const spec: AgentLaunchSpec = {
    version: 2,
    agent: {
      id: input.agentId,
      type,
      displayName: config2.displayName,
      description: input.description,
    },
    session: {
      id: input.childSessionId,
      name: agentSessionName(input.description),
      parentFile: input.parentSessionFile,
      sessionDir: input.sessionDir,
    },
    runtime: {
      cwd: effectiveCwd,
      packageDir: getPackageDir(),
      model: { provider: options.model.provider, id: options.model.id },
      thinking: options.thinking,
      tools: allowedTools,
      noExtensions,
      extensionPaths: finalExtensionPaths,
      noSkills,
      systemPrompt,
    },
    run: {
      prompt: effectivePrompt,
      maxTurns: normalizeMaxTurns(options.maxTurns ?? getDefaultMaxTurns()),
      graceTurns: getGraceTurns(),
      handoff: options.handoff,
    },
    bridge: { mailboxDir: input.mailboxDir },
  };

  if (!input.parentSessionFile) {
    warnings.push(
      "Parent session is ephemeral (--no-session); the agent session cannot be nested under it and will appear as a root session in /resume",
    );
  }

  return { spec, warnings };
}

/** Write a launch spec atomically. The child deletes it after reading. */
export function writeLaunchSpec(path: string, spec: AgentLaunchSpec): void {
  writeJsonAtomic(path, spec);
}
