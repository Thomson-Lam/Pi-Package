import { Text } from "@earendil-works/pi-tui";
import type { FreshContextMessageDetails } from "../fresh/types.js";

export function renderFreshContextMessage(message: any, options: { expanded: boolean }, theme: any) {
  const details = message.details as FreshContextMessageDetails | undefined;
  if (!details) return new Text(theme.fg("accent", "Fresh file context"), 0, 0);

  const lines = [
    theme.fg("accent", theme.bold(`Fresh context: ${details.paths.length} files · est. ${formatTokens(details.estimatedTokens)} tokens`)),
  ];
  if (options.expanded) {
    lines.push(...details.paths.map((file) => `  ${file.path}  ${formatBytes(file.bytes)} · est. ${formatTokens(file.estimatedTokens)} tokens`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

function formatBytes(count: number): string {
  if (count < 1000) return `${count} B`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)} KB`;
}
