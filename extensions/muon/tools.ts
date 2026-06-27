import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MuonState } from "./types.js";

export interface MuonToolDeps {
  getState: () => MuonState;
  setState: (updater: (draft: MuonState) => void, ctx: ExtensionContext) => void;
}

export function registerMuonTools(_pi: ExtensionAPI, _deps: MuonToolDeps): void {}
