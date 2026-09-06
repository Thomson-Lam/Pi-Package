/**
 * names.ts — Zellij-style generated names for agent windows and fleet rows,
 * plus timestamped, descriptive names for saved /resume sessions.
 *
 * Window and fleet names are deterministic per agent id so reopened windows
 * and their fleet rows stay consistent.
 */

/** Zellij's embedded adjective list (zellij 0.44). */
export const ZELLIJ_ADJECTIVES = [
  "adamant", "adept", "adventurous", "auspicious", "awesome", "blossoming",
  "brave", "chatty", "considerate", "cubic", "curious", "delighted",
  "effulgent", "erudite", "excellent", "exquisite", "fascinating", "glowing",
  "gregarious", "hopeful", "implacable", "inventive", "joyous", "judicious",
  "jumping", "likable", "loyal", "lucky", "marvellous", "mellifluous",
  "oblong", "outstanding", "polite", "quadratic", "quiet", "rectangular",
  "remarkable", "rusty", "sincere", "sparkling", "stellar", "tenacious",
  "tremendous", "triangular", "undulating", "unflappable", "unique", "verdant",
  "zippy",
];

/** Zellij's embedded noun list (zellij 0.44). */
export const ZELLIJ_NOUNS = [
  "accordion", "apple", "apricot", "bee", "brachiosaur", "cactus", "cowbell",
  "cuckoo", "cymbal", "diplodocus", "donkey", "echidna", "galaxy",
  "glockenspiel", "goose", "horse", "iguana", "jellyfish", "lemon", "lemur",
  "magpie", "megalodon", "mouse", "muskrat", "ocelot", "panda", "peach",
  "pepper", "petunia", "piano", "pigeon", "quasar", "rhinoceros", "river",
  "rustacean", "salamander", "sitar", "stegosaurus", "tambourine", "tiger",
  "tomato", "triceratops", "ukulele", "viola", "weasel", "xylophone", "yak",
  "zebra",
];

/** FNV-1a 32-bit hash — stable across processes (no Math.random). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Legacy fleet codename retained for existing fleet-row presentation. */
export function zellijName(seed: string): string {
  const h = hashString(seed);
  return `${ZELLIJ_ADJECTIVES[h % ZELLIJ_ADJECTIVES.length]}-${ZELLIJ_NOUNS[Math.floor(h / ZELLIJ_ADJECTIVES.length) % ZELLIJ_NOUNS.length]}`;
}

/** Short agent-type label used by the fleet view. */
export function agentTypeSlug(type: string): string {
  if (type.toLowerCase() === "general-purpose") return "general";
  return type.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "agent";
}

/** Legacy lookup name for windows created before description-based labels. */
export function legacyAgentWindowName(seed: string, type: string): string {
  const h = hashString(seed);
  const adj = ZELLIJ_ADJECTIVES[h % ZELLIJ_ADJECTIVES.length]!;
  const noun = ZELLIJ_NOUNS[Math.floor(h / ZELLIJ_ADJECTIVES.length) % ZELLIJ_NOUNS.length]!;
  const slug = type.toLowerCase() === "general-purpose"
    ? "general"
    : type.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "agent";
  return `${adj}-${noun}-${slug}`.slice(0, 48);
}

function truncateAtDelimiter(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const delimiter = clipped.lastIndexOf("-");
  return (delimiter > 0 ? clipped.slice(0, delimiter) : clipped).replace(/-+$/g, "");
}

/** Convert a task description into a readable, tmux-safe window name. */
export function agentWindowName(description: string): string {
  const name = description
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return truncateAtDelimiter(name, 48) || "agent";
}

/** Mark a window as hosting an agent that can have child agents. */
export function parentWindowName(name: string): string {
  const label = name.match(/\[S\]:\s*(.+)$/)?.[1] ?? name;
  const base = agentWindowName(label.replace(/^\[P\]\s*/i, ""));
  return `[P] ${truncateAtDelimiter(base, 44)}`;
}

/** Local HH:MM timestamp. */
export function localTimeStamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** /resume session name, e.g. "21:20-[S]: inspect approval flickering". */
export function agentSessionName(description: string): string {
  return `${localTimeStamp()}-[S]: ${description}`;
}
