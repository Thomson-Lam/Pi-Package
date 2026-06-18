import os from "node:os";
import path from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_DIR } from "./constants.js";
import { getPlanModeRoot } from "./storage.js";
import type { PlanModeState } from "./types.js";

const ALLOWED_COMMANDS = new Set([
  "pwd",
  "ls",
  "tree",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "rg",
  "grep",
  "find",
  "fd",
  "jq",
  "awk",
  "cut",
  "sort",
  "uniq",
  "which",
  "whereis",
  "git",
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch"]);

const BLOCKED_TOKENS = [
  "sudo",
  "su",
  "doas",
  "eval",
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "tee",
  "touch",
  "mkdir",
  "rmdir",
  "ln",
  "truncate",
  "sed",
  "perl",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "python",
  "node",
  "nvim",
  "vim",
  "emacs",
  "code",
  "cd",
  "curl",
  "wget",
  "scp",
  "rsync",
  "tar",
  "zip",
  "unzip",
];

function isWithinAllowedRoots(targetPath: string, roots: string[]): boolean {
  const resolved = path.resolve(targetPath);
  return roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

function allowedRoots(state: PlanModeState, cwd: string): string[] {
  const roots = [path.resolve(cwd), path.resolve(PLAN_MODE_DIR), path.resolve(getPlanModeRoot({ mode: state.planStoreMode, cwd }))];
  for (const location of Object.values(state.planLocations ?? {})) {
    roots.push(path.dirname(location.path));
  }
  return [...new Set(roots)];
}

function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

function hasDangerousShellSyntax(command: string): string | undefined {
  if (/`|\$\(/.test(command)) return "command substitution is blocked";
  if (/(^|\s)(\d?>|>>|<|<<|<<<|>&|&>)/.test(command)) return "shell redirection is blocked";
  return undefined;
}

function hasBlockedRecursiveFlags(tokens: string[]): boolean {
  return tokens.some((t) => t === "-r" || t === "-R" || t === "-rf" || t === "-fr" || t === "--recursive");
}

function maybePathToken(token: string): boolean {
  return token === "." || token === ".." || token.startsWith("~") || token.includes("/") || token.startsWith(".");
}

function resolvePathToken(token: string, cwd: string): string {
  if (token.startsWith("~/")) return path.join(os.homedir(), token.slice(2));
  if (token === "~") return os.homedir();
  if (path.isAbsolute(token)) return token;
  return path.resolve(cwd, token);
}

function validateSegment(segment: string, roots: string[], cwd: string): string | undefined {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return undefined;

  if (hasBlockedRecursiveFlags(tokens)) return "recursive flags are blocked in plan mode";

  const [cmd, ...rest] = tokens;

  if (BLOCKED_TOKENS.includes(cmd)) return `blocked command: ${cmd}`;
  if (!ALLOWED_COMMANDS.has(cmd)) return `command not allowlisted: ${cmd}`;

  if (cmd === "git") {
    const sub = rest.find((t) => !t.startsWith("-"));
    if (!sub || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) return `git subcommand not allowlisted: ${sub ?? "(none)"}`;
  }

  for (const token of rest) {
    if (token.startsWith("-")) continue;
    if (token === "-") continue;
    if (!maybePathToken(token)) continue;
    const resolved = resolvePathToken(token, cwd);
    if (!isWithinAllowedRoots(resolved, roots)) {
      return `path escapes allowed roots: ${token}`;
    }
  }

  return undefined;
}

function validateBashCommand(command: string, state: PlanModeState, cwd: string): string | undefined {
  const roots = allowedRoots(state, cwd);
  const shellProblem = hasDangerousShellSyntax(command);
  if (shellProblem) return shellProblem;

  const segments = splitSegments(command);
  if (segments.length === 0) return "empty command";

  for (const segment of segments) {
    const problem = validateSegment(segment, roots, cwd);
    if (problem) return problem;
  }

  return undefined;
}

export function guardToolCall(event: any, state: PlanModeState, cwd: string) {
  if (!state.enabled) return undefined;

  const roots = allowedRoots(state, cwd);

  if (isToolCallEventType("write", event)) {
    if (!isWithinAllowedRoots(event.input.path, roots)) {
      return { block: true, reason: `Plan mode only allows writes under: ${roots.join(", ")}` };
    }
  }

  if (isToolCallEventType("edit", event)) {
    if (!isWithinAllowedRoots(event.input.path, roots)) {
      return { block: true, reason: `Plan mode only allows edits under: ${roots.join(", ")}` };
    }
  }

  if (isToolCallEventType("bash", event)) {
    const reason = validateBashCommand(event.input.command, state, cwd);
    if (reason) {
      return { block: true, reason: `Plan mode bash blocked: ${reason}` };
    }
  }

  return undefined;
}
