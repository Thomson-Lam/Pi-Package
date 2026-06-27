import { Text } from "@earendil-works/pi-tui";

export function renderMuonSubagentResult(result: any, _options: { expanded?: boolean }, theme: any) {
  const details = result.details;
  const runId = details?.runId ?? "unknown";
  const ledgerPath = details?.ledgerPath ?? "no ledger";
  const count = Array.isArray(details?.results) ? details.results.length : 0;
  return new Text(`${theme.fg("toolTitle", "muon_subagent")} ${theme.fg("accent", runId)} ${theme.fg("muted", `${count} result(s)`)}\n${theme.fg("dim", ledgerPath)}`, 0, 0);
}
