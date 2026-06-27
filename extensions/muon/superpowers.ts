import type { MuonState } from "./types.js";

export function resetSuperpowersBootstrap(state: MuonState): void { state.injectBootstrapThisSession = true; }
export function discoverSuperpowersResources(_state: MuonState): { skillPaths?: string[] } { return {}; }
export function maybeInjectSuperpowersBootstrap(_event: { messages: unknown[] }, _state: MuonState): undefined { return undefined; }
