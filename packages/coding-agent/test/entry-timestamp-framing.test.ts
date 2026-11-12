import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const message: AssistantMessage = {
	role: "assistant",
	api: "openai-responses",
	provider: "example",
	model: "example-model",
	content: [
		{ type: "thinking", thinking: "First thought. More details." },
		{ type: "text", text: "日本語 👀\n\nhttps://example.com/a-long-wrapped-path-with-multiple-segments" },
		{ type: "thinking", thinking: "Another thought." },
	],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};
const timestampPattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/g;

// nredd/pi#30: decorations occupy framing slots and never replace content components.
describe("timestamp framing", () => {
	beforeAll(() => initTheme("dark"));

	it.each([20, 40, 80, 120])("keeps assistant content and OSC133 identical at width %i", (width) => {
		const component = new AssistantMessageComponent(message, true);
		const baseline = component.render(width);
		component.entryTimestamp.setEnabled(true);
		const decorated = component.render(width);
		expect(decorated).toHaveLength(baseline.length);
		expect(decorated.slice(1)).toEqual(baseline.slice(1));
		expect(decorated[0]).toContain("\x1b]133;A\x07");
		expect(decorated.join("\n").match(timestampPattern)?.length ?? 0).toBe(width >= 28 ? 1 : 0);
		for (const line of decorated) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		component.entryTimestamp.setEnabled(false);
		expect(component.render(width)).toEqual(baseline);
	});

	it.each([20, 40, 80, 120])("reuses user padding without changing Markdown output at width %i", (width) => {
		const text = "日本語 👀\n\n[link](https://example.com/a-long-path)";
		const component = new UserMessageComponent(text);
		const baseline = component.render(width);
		const original = new Markdown(
			text,
			1,
			1,
			getMarkdownTheme(),
			{
				color: (content) => theme.fg("userMessageText", content),
				bgColor: (content) => theme.bg("userMessageBg", content),
			},
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		).render(width);
		expect(baseline.map(stripTerminalSequences)).toEqual(original.map(stripTerminalSequences));
		component.entryTimestamp.setTime({ messageTimestamp: 0 });
		component.entryTimestamp.setEnabled(true);
		const decorated = component.render(width);
		expect(decorated).toHaveLength(baseline.length);
		expect(decorated.slice(1)).toEqual(baseline.slice(1));
		expect(decorated.join("\n").match(timestampPattern)?.length ?? 0).toBe(width >= 28 ? 1 : 0);
		component.entryTimestamp.setEnabled(false);
		expect(component.render(width)).toEqual(baseline);
	});

	it("keeps extension message disclosure state across timestamp toggles", () => {
		const component = new CustomMessageComponent(
			{ role: "custom", customType: "example", content: "source", display: true, timestamp: 0 },
			() => new Markdown("call\n\nmore details", 0, 0, getMarkdownTheme()),
		);
		component.setExpanded(true);
		const expanded = component.render(80);
		component.entryTimestamp.setEnabled(true);
		expect(component.render(80).slice(1)).toEqual(expanded.slice(1));
		expect(stripTerminalSequences(component.render(80).join("\n"))).toContain("more details");
		component.setExpanded(false);
		expect(component.render(80)).toHaveLength(2);
		expect(component.render(80).join("\n").match(timestampPattern)).toHaveLength(1);
	});
});
