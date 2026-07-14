import type {
	ReadonlySessionManager,
	SessionEntry,
	SessionTreeNode,
} from "@mariozechner/pi-coding-agent";

export type SessionTreeSearchMode = "all" | "user" | "agent" | "tools";
export type SessionTreeItemKind =
	| "user"
	| "agent"
	| "tool"
	| "summary"
	| "compaction"
	| "custom";

export interface SessionTreeSearchItem {
	kind: SessionTreeItemKind;
	entryId: string;
	navigationTargetId: string;
	parentId: string | null;
	depth: number;
	active: boolean;
	label?: string;
	labelTimestamp?: string;
	title: string;
	searchText: string;
	previewText: string;
	toolCallId?: string;
	toolName?: string;
	toolArguments?: Record<string, unknown>;
}

interface ToolResultInfo {
	entry: SessionEntry;
	text: string;
	label?: string;
	labelTimestamp?: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function oneLine(text: string, max = 140): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function flattenTree(roots: SessionTreeNode[]): Array<{ node: SessionTreeNode; depth: number }> {
	const result: Array<{ node: SessionTreeNode; depth: number }> = [];
	const stack = roots
		.slice()
		.reverse()
		.map((node) => ({ node, depth: 0 }));

	while (stack.length > 0) {
		const current = stack.pop()!;
		result.push(current);
		for (let i = current.node.children.length - 1; i >= 0; i--) {
			stack.push({ node: current.node.children[i]!, depth: current.depth + 1 });
		}
	}
	return result;
}

function includeItem(mode: SessionTreeSearchMode, kind: SessionTreeItemKind): boolean {
	if (mode === "all") return true;
	if (mode === "user") return kind === "user";
	if (mode === "agent") return kind === "agent";
	return kind === "tool";
}

function withCommonSearchText(item: SessionTreeSearchItem): SessionTreeSearchItem {
	item.searchText = [item.kind, item.label, item.title, item.searchText]
		.filter(Boolean)
		.join(" ");
	return item;
}

/** Collect searchable items from every branch of the current session tree. */
export function collectSessionTreeItems(
	sessionManager: Pick<ReadonlySessionManager, "getTree" | "getBranch">,
	mode: SessionTreeSearchMode,
): SessionTreeSearchItem[] {
	const flattened = flattenTree(sessionManager.getTree());
	const activeIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
	const toolResults = new Map<string, ToolResultInfo>();

	for (const { node } of flattened) {
		const entry = node.entry;
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		toolResults.set(entry.message.toolCallId, {
			entry,
			text: extractText(entry.message.content),
			label: node.label,
			labelTimestamp: node.labelTimestamp,
		});
	}

	const items: SessionTreeSearchItem[] = [];
	const matchedToolResultIds = new Set<string>();

	for (const { node, depth } of flattened) {
		const entry = node.entry;
		const common = {
			entryId: entry.id,
			parentId: entry.parentId,
			depth,
			active: activeIds.has(entry.id),
			label: node.label,
			labelTimestamp: node.labelTimestamp,
		};

		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				const text = extractText(message.content);
				if (text.trim() && includeItem(mode, "user")) {
					items.push(withCommonSearchText({
						...common,
						kind: "user",
						navigationTargetId: entry.id,
						title: oneLine(text),
						searchText: text,
						previewText: text,
					}));
				}
				continue;
			}

			if (message.role === "assistant") {
				const text = extractText(message.content);
				if (text.trim() && includeItem(mode, "agent")) {
					items.push(withCommonSearchText({
						...common,
						kind: "agent",
						navigationTargetId: entry.id,
						title: oneLine(text),
						searchText: text,
						previewText: text,
					}));
				}

				if (includeItem(mode, "tool") && Array.isArray(message.content)) {
					for (const block of message.content) {
						if (
							typeof block !== "object" ||
							block === null ||
							(block as { type?: unknown }).type !== "toolCall"
						) continue;

						const call = block as {
							id: string;
							name: string;
							arguments: Record<string, unknown>;
						};
						const result = toolResults.get(call.id);
						if (result) matchedToolResultIds.add(result.entry.id);
						const argsText = stringify(call.arguments);
						const resultText = result?.text ?? "";
						items.push(withCommonSearchText({
							...common,
							kind: "tool",
							navigationTargetId: result?.entry.id ?? entry.id,
							active: activeIds.has(result?.entry.id ?? entry.id),
							label: result?.label ?? node.label,
							labelTimestamp: result?.labelTimestamp ?? node.labelTimestamp,
							title: `${call.name} ${oneLine(argsText, 110)}`.trim(),
							searchText: `${call.name} ${argsText} ${resultText}`,
							previewText: [
								`Tool: ${call.name}`,
								`Call ID: ${call.id}`,
								"",
								"Arguments:",
								argsText,
								...(resultText ? ["", "Result:", resultText] : []),
							].join("\n"),
							toolCallId: call.id,
							toolName: call.name,
							toolArguments: call.arguments,
						}));
					}
				}
				continue;
			}

			if (message.role === "toolResult") {
				if (!includeItem(mode, "tool") || matchedToolResultIds.has(entry.id)) continue;
				const text = extractText(message.content);
				items.push(withCommonSearchText({
					...common,
					kind: "tool",
					navigationTargetId: entry.id,
					title: `${message.toolName} ${oneLine(text, 110)}`.trim(),
					searchText: `${message.toolName} ${text}`,
					previewText: text,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				}));
				continue;
			}

			if (message.role === "bashExecution" && includeItem(mode, "tool")) {
				const command = message.command ?? "";
				items.push(withCommonSearchText({
					...common,
					kind: "tool",
					navigationTargetId: entry.id,
					title: `bash ${oneLine(command, 110)}`,
					searchText: `bash ${command} ${message.output ?? ""}`,
					previewText: `$ ${command}\n\n${message.output ?? ""}`,
					toolName: "bash",
				}));
			}
			continue;
		}

		if (mode !== "all") continue;
		if (entry.type === "branch_summary") {
			items.push(withCommonSearchText({
				...common,
				kind: "summary",
				navigationTargetId: entry.id,
				title: oneLine(entry.summary),
				searchText: entry.summary,
				previewText: entry.summary,
			}));
		} else if (entry.type === "compaction") {
			items.push(withCommonSearchText({
				...common,
				kind: "compaction",
				navigationTargetId: entry.id,
				title: `Compaction (${entry.tokensBefore} tokens)`,
				searchText: entry.summary,
				previewText: entry.summary,
			}));
		} else if (entry.type === "custom_message") {
			const text = extractText(entry.content);
			items.push(withCommonSearchText({
				...common,
				kind: "custom",
				navigationTargetId: entry.id,
				title: `[${entry.customType}] ${oneLine(text)}`,
				searchText: `${entry.customType} ${text}`,
				previewText: text,
			}));
		}
	}

	return items;
}
