import type { ContextItem, InspectorDensity, InspectorState, ReadEvent, SystemPromptOptionsSnapshot } from "./types.js";

const MAX_READ_EVENTS = 500;

export const inspectorState: InspectorState = {
  readEvents: [],
  lastReconstructed: [],
  panelOpen: false,
  selectedIndex: 0,
  mode: "list",
  density: "logical",
  filter: "",
};

export function resetVolatileState() {
  inspectorState.lastSystemPrompt = undefined;
  inspectorState.lastSystemPromptOptions = undefined;
  inspectorState.readEvents = [];
  inspectorState.lastReconstructed = [];
  inspectorState.panelOpen = false;
  inspectorState.selectedIndex = 0;
  inspectorState.detailItemId = undefined;
  inspectorState.mode = "list";
  inspectorState.filter = "";
}

export function captureSystemPrompt(systemPrompt?: string, options?: unknown) {
  inspectorState.lastSystemPrompt = systemPrompt;
  inspectorState.lastSystemPromptOptions = normalizeSystemPromptOptions(options);
}

export function addReadEvent(event: Omit<ReadEvent, "id" | "timestamp"> & { id?: string; timestamp?: number }) {
  const readEvent: ReadEvent = {
    id: event.id ?? `read-${Date.now()}-${inspectorState.readEvents.length + 1}`,
    path: event.path,
    offset: event.offset,
    limit: event.limit,
    timestamp: event.timestamp ?? Date.now(),
    turnIndexHint: event.turnIndexHint,
    toolCallId: event.toolCallId,
  };
  inspectorState.readEvents.push(readEvent);
  if (inspectorState.readEvents.length > MAX_READ_EVENTS) {
    inspectorState.readEvents.splice(0, inspectorState.readEvents.length - MAX_READ_EVENTS);
  }
}

export function updateReadEventResult(toolCallId: string | undefined, preview: string, resultLength: number, isError?: boolean, resultContent?: string) {
  if (!toolCallId) return;
  const event = [...inspectorState.readEvents].reverse().find((e) => e.toolCallId === toolCallId);
  if (!event) return;
  event.resultPreview = preview;
  event.resultContent = resultContent;
  event.resultLength = resultLength;
  event.isError = isError;
}

export function setLastReconstructed(items: ContextItem[]) {
  inspectorState.lastReconstructed = items;
  if (inspectorState.selectedIndex >= items.length) {
    inspectorState.selectedIndex = Math.max(0, items.length - 1);
  }
}

export function setDensity(density: InspectorDensity) {
  inspectorState.density = density;
}

function normalizeSystemPromptOptions(options: unknown): SystemPromptOptionsSnapshot | undefined {
  if (!options || typeof options !== "object") return undefined;
  const raw = options as any;
  const contextFiles = Array.isArray(raw.contextFiles)
    ? raw.contextFiles.map((f: any) => ({
        path: String(f?.path ?? f?.filePath ?? f?.name ?? "context file"),
        content: typeof f?.content === "string" ? f.content : undefined,
      }))
    : [];
  const skills = Array.isArray(raw.skills)
    ? raw.skills.map((s: any) => ({
        name: String(s?.name ?? s?.skillName ?? s?.filePath ?? "skill"),
        filePath: String(s?.filePath ?? s?.path ?? ""),
        description: typeof s?.description === "string" ? s.description : undefined,
      }))
    : [];
  return { contextFiles, skills };
}
