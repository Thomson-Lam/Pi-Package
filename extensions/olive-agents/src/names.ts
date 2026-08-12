/**
 * names.ts — Generated names for agent windows, fleet rows, and /resume
 * sessions, in the style of Zellij's auto-generated pane names
 * (adjective-noun codenames). The word lists are Zellij's own (extracted from
 * zellij 0.44), so the generated names match what you'd see in zellij.
 *
 * Names are deterministic per agent id: the same agent always gets the same
 * codename, so a reopened window, its fleet row, and its /resume session all
 * stay consistent.
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

/** Zellij-style codename, deterministic from a seed (e.g. the agent id). */
export function zellijName(seed: string): string {
  const h = hashString(seed);
  const adj = ZELLIJ_ADJECTIVES[h % ZELLIJ_ADJECTIVES.length]!;
  const noun = ZELLIJ_NOUNS[Math.floor(h / ZELLIJ_ADJECTIVES.length) % ZELLIJ_NOUNS.length]!;
  return `${adj}-${noun}`;
}

/** Short agent-type tag: general-purpose → "general", Review → "review", others slugified. */
export function agentTypeSlug(type: string): string {
  const t = type.toLowerCase();
  if (t === "general-purpose") return "general";
  return t.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "agent";
}

/** tmux window name: "<codename>-<type>", e.g. "sparkling-panda-general". */
export function agentWindowName(seed: string, type: string): string {
  return `${zellijName(seed)}-${agentTypeSlug(type)}`.slice(0, 48);
}

/** Local HH:MM timestamp. */
export function localTimeStamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * /resume session name: "<HH:MM> <codename>-<type>",
 * e.g. "21:20 unique-mouse-general" (timestamp generated with Node).
 */
export function agentSessionName(seed: string, type: string): string {
  return `${localTimeStamp()} ${agentWindowName(seed, type)}`;
}
