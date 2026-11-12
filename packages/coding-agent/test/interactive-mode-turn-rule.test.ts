import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, type TranscriptNavigationTarget } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { EntryTimestamp } from "../src/modes/interactive/components/entry-timestamp.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptEntryIdentities } from "../src/modes/interactive/transcript-entries.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type ChatContext = {
	transcriptIdentities: TranscriptEntryIdentities;
	transcriptTargets: TranscriptNavigationTarget[];
	chatContainer: Container;
	outputPad: number;
	settingsManager: { getShowTimestamps(): boolean };
	configureEntryTimestamp: <T extends Component & { entryTimestamp: EntryTimestamp }>(
		component: T,
		message: AgentMessage,
	) => T;
	editor: { addToHistory?: (text: string) => void };
	getUserMessageText: (message: AgentMessage) => string;
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers: () => [];
};

const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
	this: ChatContext,
	message: AgentMessage,
) => void;
const getUserMessageText = Reflect.get(InteractiveMode.prototype, "getUserMessageText") as (
	message: AgentMessage,
) => string;

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function createContext(): ChatContext {
	return {
		chatContainer: new Container(),
		transcriptIdentities: new TranscriptEntryIdentities(),
		transcriptTargets: [],
		outputPad: 1,
		settingsManager: { getShowTimestamps: () => false },
		configureEntryTimestamp: Reflect.get(
			InteractiveMode.prototype,
			"configureEntryTimestamp",
		) as ChatContext["configureEntryTimestamp"],
		editor: {},
		getUserMessageText,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
	};
}

describe("InteractiveMode turn rule", () => {
	test("opens every user turn after the first with a muted rule instead of a blank line", () => {
		initTheme("dark");
		const context = createContext();

		addMessageToChat.call(context, user("first"));
		addMessageToChat.call(context, user("second"));
		const lines = context.chatContainer.render(40).map((line) => stripAnsi(line).trimEnd());

		const rule = "─".repeat(40);
		const first = lines.findIndex((line) => line.includes("first"));
		const second = lines.findIndex((line) => line.includes("second"));
		const rules = lines.flatMap((line, index) => (line === rule ? [index] : []));
		expect(rules).toHaveLength(1);
		expect(rules[0]).toBeGreaterThan(first);
		expect(rules[0]).toBeLessThan(second);
		// The rule replaces the spacer: the band's own padding row follows it directly.
		expect(lines[rules[0]! + 2]).toContain("second");
	});
});
