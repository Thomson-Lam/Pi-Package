export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function badge(text: string, kind = "neutral"): string {
  return `<span class="badge badge-${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

export function riskBadge(risk?: string): string {
  return risk ? badge(`risk: ${risk}`, `risk-${risk}`) : "";
}

export function statusBadge(status: string): string {
  const first = status.charAt(0).toUpperCase();
  const label =
    first === "A" ? "added" : first === "M" ? "modified" : first === "D" ? "deleted" : first === "R" ? "renamed" : first === "C" ? "copied" : status;
  return badge(label, `status-${first || "unknown"}`);
}

export function validationBadge(result: string): string {
  return badge(result, `validation-${result}`);
}

export function list(items: string[] | undefined, empty = "None recorded."): string {
  if (!items || items.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}
