import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { isEntryRule } from "../src/modes/interactive/components/entry-rule.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(stripAnsi(rendered)).toContain("▸ Thinking · private reasoning");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one collapsed thinking row", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking · /g)).toHaveLength(1);
		expect(rendered).toContain("▸ Thinking · first thought");
		expect(rendered).not.toContain("second thought");
		expect(rendered).toContain("│ answer");
	});

	test("collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		expect(stripAnsi(lines[firstThinkingRow] ?? "")).toContain("▾  first reasoning");
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 0,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).toContain("▸ Thinking · first reasoning");
		expect(collapsed).not.toContain("▾  first reasoning");
		expect(collapsed).toContain("▾  second reasoning");

		expect(component.handleMouse({ ...event, x: 4 })?.handled).toBe(true);
		const expandedAgain = stripAnsi(component.render(width).join("\n"));
		expect(expandedAgain).toContain("▾  first reasoning");

		const answerRow = component.render(width).findIndex((line) => stripAnsi(line).includes("answer"));
		expect(answerRow).toBeGreaterThan(firstThinkingRow);
		expect(component.handleMouse({ ...event, y: answerRow, screenY: answerRow })).toBeUndefined();
		expect(stripAnsi(component.render(width).join("\n"))).toContain("first reasoning");
	});

	test("collapses an expanded thinking run from a lower body row", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "top reasoning\n\nmiddle reasoning\n\nbottom reasoning" },
				{ type: "text", text: "answer" },
			]),
		);
		const width = 80;
		const lines = component.render(width);
		const bottomRow = lines.findIndex((line) => stripAnsi(line).includes("bottom reasoning"));
		const topRow = lines.findIndex((line) => stripAnsi(line).includes("top reasoning"));
		expect(bottomRow).toBeGreaterThan(topRow);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 6,
			y: bottomRow,
			screenX: 6,
			screenY: bottomRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse({ ...event, type: "press" })).toBeUndefined();
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).toContain("▸ Thinking · top reasoning");
		expect(collapsed).not.toContain("bottom reasoning");
		expect(collapsed).toContain("answer");
	});

	test("collapses thinking from a body row when an extension trims the leading blank line", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first line\n\nlast line" },
				{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "ls" } },
			]),
		);
		const original = component.render.bind(component);
		component.render = (width: number) => {
			const rendered = original(width);
			const trimmed = [...rendered];
			while (trimmed.length > 0 && stripAnsi(trimmed[0] ?? "").trim().length === 0) trimmed.shift();
			while (trimmed.length > 0 && stripAnsi(trimmed[trimmed.length - 1] ?? "").trim().length === 0) trimmed.pop();
			return trimmed;
		};
		const transcript = new Container();
		transcript.addChild(component);

		const width = 80;
		const lines = transcript.render(width);
		const lastRow = lines.findIndex((line) => stripAnsi(line).includes("last line"));
		expect(lastRow).toBeGreaterThan(0);
		expect(
			transcript.handleMouse({
				type: "click",
				button: "left",
				x: 6,
				y: lastRow,
				screenX: 6,
				screenY: lastRow,
				width,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
		const collapsed = stripAnsi(transcript.render(width).join("\n"));
		expect(collapsed).toContain("▸ Thinking · first line");
		expect(collapsed).not.toContain("last line");
	});

	test("toggles thinking when an extension trims the leading blank line", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "hidden reasoning" },
				{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "ls" } },
			]),
			true,
		);

		// Mirrors @vanillagreen/pi-tool-renderer's prototype patch: trim the outer blank
		// lines and reattach the OSC 133 zone start to the new first line.
		const original = component.render.bind(component);
		component.render = (width: number) => {
			const rendered = original(width);
			const trimmed = [...rendered];
			while (
				trimmed.length > 0 &&
				(stripAnsi(trimmed[0] ?? "").trim().length === 0 || isEntryRule(trimmed[0] ?? ""))
			)
				trimmed.shift();
			while (trimmed.length > 0 && stripAnsi(trimmed[trimmed.length - 1] ?? "").trim().length === 0) trimmed.pop();
			if (rendered[0]?.includes(OSC133_ZONE_START) && !trimmed[0]?.includes(OSC133_ZONE_START)) {
				trimmed[0] = `${OSC133_ZONE_START}${trimmed[0] ?? ""}`;
			}
			return trimmed;
		};

		// The transcript dispatches through the chat container, never the message directly.
		const transcript = new Container();
		transcript.addChild(component);

		const width = 80;
		const lines = transcript.render(width);
		const headerRow = lines.findIndex((line) => stripAnsi(line).includes("Thinking · hidden reasoning"));
		expect(headerRow).toBe(0);

		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 0,
			y: headerRow,
			screenX: 0,
			screenY: headerRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(transcript.handleMouse(event)?.handled).toBe(true);

		const expanded = stripAnsi(transcript.render(width).join("\n"));
		expect(expanded).toContain("▾  hidden reasoning");
		expect(expanded).not.toContain("Thinking · ");
	});

	test("rules prose regardless of output padding and pads thinking by it", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.startsWith("│ hello"))).toBe(true);
		expect(lines.some((line) => line.startsWith("▾  reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("│ hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("▾ reasoning"))).toBe(true);
	});

	test("rules every prose line, blanks included, and leaves errors unruled", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "first paragraph\n\nsecond paragraph" }], {
				stopReason: "error",
			}),
		);
		const lines = component.render(80).map((line) => stripAnsi(line));
		const first = lines.findIndex((line) => line.includes("first paragraph"));
		const second = lines.findIndex((line) => line.includes("second paragraph"));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBe(first + 2);
		expect(lines.slice(first, second + 1).map((line) => line.trimEnd())).toEqual([
			"│ first paragraph",
			"│",
			"│ second paragraph",
		]);
		const errorRow = lines.find((line) => line.includes("Error: Unknown error"));
		expect(errorRow).toBeDefined();
		expect(errorRow).not.toContain("│");
	});

	test("rules streaming prose the same as settled prose", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage([{ type: "text", text: "partial" }]), true);
		const lines = component.render(80).map((line) => stripAnsi(line));
		expect(lines.some((line) => line.startsWith("│ partial"))).toBe(true);
	});

	test("summarizes collapsed thinking with its first sentence and the configured label head", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "Check the addon first! Then restart it.\n\nMore detail." },
				{ type: "text", text: "answer" },
			]),
			true,
			undefined,
			"Pondering…",
		);
		const row = component
			.render(120)
			.map((line) => stripAnsi(line))
			.find((line) => line.includes("Pondering"));
		expect(row).toBe("▸ Pondering · Check the addon first!");

		const narrow = component
			.render(30)
			.map((line) => stripAnsi(line))
			.find((line) => line.includes("Pondering"));
		expect(narrow).toBeDefined();
		expect(narrow?.length).toBeLessThanOrEqual(30);
		expect(narrow).toMatch(/…$/);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
