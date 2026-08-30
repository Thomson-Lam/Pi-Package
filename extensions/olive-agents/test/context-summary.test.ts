import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HANDOFF_COMPACTION_PROMPT } from "../src/approval.js";
import { summarizeSelections } from "../src/context-ledger.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: vi.fn(),
}));

const completeSimpleMock = vi.mocked(completeSimple);

const model = {
  provider: "test",
  id: "basic",
  maxTokens: 8192,
  reasoning: false,
} as unknown as Model<never>;

const branch = [{
  type: "message",
  id: "m1",
  parentId: null,
  timestamp: "2025-01-01T00:00:00.000Z",
  message: { role: "user", content: "Auth was deferred because time to first feature mattered more." },
}] as never[];

describe("context-ledger summarization", () => {
  it("uses the ledger prompt directly instead of native sectioned compaction", async () => {
    completeSimpleMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "- Auth was deferred because time to first feature mattered more." }],
    } as never);

    const result = await summarizeSelections(
      { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
      {
        branch,
        selectedIds: ["m1"],
        model,
        thinking: "off",
        customInstructions: DEFAULT_HANDOFF_COMPACTION_PROMPT,
      },
    );

    const [, context, options] = completeSimpleMock.mock.calls[0]!;
    const prompt = (context as any).messages[0].content[0].text as string;
    expect(result).toContain("Auth was deferred");
    expect((context as any).systemPrompt).toContain("context ledger summarization assistant");
    expect(prompt).toContain("Auth was deferred because time to first feature mattered more.");
    expect(prompt).toContain(DEFAULT_HANDOFF_COMPACTION_PROMPT);
    expect(prompt).not.toContain("## Next Steps");
    expect((options as any).cacheRetention).toBe("none");
  });
});
