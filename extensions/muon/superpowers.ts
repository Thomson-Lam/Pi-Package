import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MUON_BOOTSTRAP_MARKER } from "./constants.js";
import type { MuonState } from "./types.js";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
let cachedBootstrapPath: string | undefined;
let cachedBootstrap: string | null | undefined;

export function resetSuperpowersBootstrap(state: MuonState): void {
  state.injectBootstrapThisSession = true;
}

export function discoverSuperpowersResources(state: MuonState): { skillPaths?: string[] } {
  if (state.config.superpowersMode === "off") return {};
  const skillsPath = state.config.superpowersSkillsPath;
  return skillsPath ? { skillPaths: [skillsPath] } : {};
}

export function maybeInjectSuperpowersBootstrap(
  event: { messages: unknown[] },
  state: MuonState,
): { messages: unknown[] } | undefined {
  if (state.config.superpowersMode !== "bootstrap") return undefined;
  if (!state.injectBootstrapThisSession) return undefined;
  if (event.messages.some(messageContainsBootstrap)) return undefined;

  const bootstrap = getBootstrapContent(state);
  if (!bootstrap) return undefined;

  const bootstrapMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: bootstrap }],
    timestamp: Date.now(),
  };

  const insertAt = firstNonCompactionSummaryIndex(event.messages);
  return { messages: [...event.messages.slice(0, insertAt), bootstrapMessage, ...event.messages.slice(insertAt)] };
}

function getBootstrapContent(state: MuonState): string | null {
  const skillsPath = state.config.superpowersSkillsPath;
  if (!skillsPath) return null;

  const bootstrapPath = resolve(skillsPath, "using-superpowers", "SKILL.md");
  if (cachedBootstrap !== undefined && cachedBootstrapPath === bootstrapPath) return cachedBootstrap;

  try {
    const skillContent = readFileSync(bootstrapPath, "utf8");
    const body = stripFrontmatter(skillContent);
    cachedBootstrapPath = bootstrapPath;
    cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${MUON_BOOTSTRAP_MARKER}

You have Muon with optional Superpowers support enabled.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

## Muon/Pi tool mapping

Pi has native skills. When Superpowers says to invoke a skill, load the relevant SKILL.md with read or let the human invoke /skill:name.

Muon provides muon_subagent and muon_workflow when active. Use muon_workflow for structured multi-agent orchestration when the user has asked for it or when a plan explicitly calls for transparent subagent orchestration.

</EXTREMELY_IMPORTANT>`;
    return cachedBootstrap;
  } catch {
    cachedBootstrapPath = bootstrapPath;
    cachedBootstrap = null;
    return null;
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.includes(MUON_BOOTSTRAP_MARKER);
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    return (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(MUON_BOOTSTRAP_MARKER)
    );
  });
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
  let index = 0;
  while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") index += 1;
  return index;
}
