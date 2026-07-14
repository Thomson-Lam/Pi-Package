import type {
	KeybindingsManager,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { copyToClipboard } from "../clipboard.js";
import type { TelescopeProvider } from "../types.js";

interface HotkeyItem {
	action: string;
	label: string;
	keys: string[];
	source: "Pi" | "Telescope";
	description?: string;
}

const TELESCOPE_UI_HOTKEYS: HotkeyItem[] = [
	{ action: "telescope.previous", label: "Previous result", keys: ["ctrl+p", "ctrl+k", "up"], source: "Telescope" },
	{ action: "telescope.next", label: "Next result", keys: ["ctrl+n", "ctrl+j", "down"], source: "Telescope" },
	{ action: "telescope.select", label: "Select result", keys: ["enter"], source: "Telescope" },
	{ action: "telescope.multiSelect", label: "Toggle multi-select", keys: ["tab"], source: "Telescope" },
	{ action: "telescope.providers", label: "Switch provider", keys: ["ctrl+r"], source: "Telescope" },
	{ action: "telescope.preview", label: "Toggle preview", keys: ["ctrl+o"], source: "Telescope" },
	{ action: "telescope.actions", label: "Provider actions", keys: ["ctrl+e"], source: "Telescope" },
	{ action: "telescope.copy", label: "Copy item", keys: ["ctrl+y"], source: "Telescope" },
	{ action: "telescope.help", label: "Telescope help", keys: ["ctrl+g"], source: "Telescope" },
	{ action: "telescope.previewUp", label: "Scroll preview up", keys: ["alt+p"], source: "Telescope" },
	{ action: "telescope.previewDown", label: "Scroll preview down", keys: ["alt+n"], source: "Telescope" },
];

function humanize(action: string): string {
	const tail = action.split(".").slice(1).join(" ") || action;
	const words = tail
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[._-]+/g, " ")
		.trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : action;
}

function displayKeys(keys: string[], theme: Theme): string {
	return keys.map((key) => theme.fg("warning", key)).join(theme.fg("dim", " / "));
}

export function createHotkeysProvider(
	providerShortcuts: Record<string, KeyId[]>,
): TelescopeProvider<HotkeyItem> {
	let keybindings: KeybindingsManager | undefined;

	return {
		name: "help",
		icon: "⌨️",
		description: "Pi and Telescope keyboard shortcuts",
		showPreviewByDefault: false,

		bindKeybindings(manager) {
			keybindings = manager;
		},

		load() {
			const effective = (keybindings?.getEffectiveConfig() ?? {}) as Record<
				string,
				KeyId | KeyId[]
			>;
			const piItems: HotkeyItem[] = Object.entries(effective)
				.map(([action, configured]) => ({
					action,
					label: humanize(action),
					keys: (Array.isArray(configured) ? configured : [configured]).map(String),
					source: "Pi" as const,
				}))
				.filter((item) => item.keys.length > 0);

			const launchItems: HotkeyItem[] = Object.entries(providerShortcuts).flatMap(
				([provider, keys]) => keys.map((key) => ({
					action: `telescope.open.${provider}`,
					label: `Open Telescope ${provider}`,
					keys: [String(key)],
					source: "Telescope" as const,
				})),
			);

			return [...piItems, ...launchItems, ...TELESCOPE_UI_HOTKEYS];
		},

		getSearchText(item) {
			return `${item.source} ${item.action} ${item.label} ${item.keys.join(" ")} ${item.description ?? ""}`;
		},

		getDisplayText(item, theme) {
			const source = item.source === "Pi"
				? theme.fg("accent", "pi")
				: theme.fg("success", "ts");
			return `[${source}] ${displayKeys(item.keys, theme)} ${item.label}`;
		},

		onSelect(item, ctx) {
			const text = item.keys[0] ?? item.action;
			if (copyToClipboard(text)) {
				ctx.ui.notify(`Copied hotkey: ${text}`, "info");
			}
		},

		getPreview(item, _maxLines, theme) {
			return [
				theme?.fg("accent", item.label) ?? item.label,
				`Action: ${item.action}`,
				`Keys: ${item.keys.join(", ")}`,
				`Source: ${item.source}`,
			];
		},

		getFrecencyKey(item) {
			return item.action;
		},
	};
}
