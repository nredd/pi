import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { ThinkingContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

// Regression: https://github.com/nredd/pi/issues/111
describe("structured thinking summaries", () => {
	it("keeps successive summary parts adjacent without changing original text", () => {
		const thinking = "**Inspecting inputs**\n\n**Checking output**";
		const block: ThinkingContent & { summaryRanges: { start: number; end: number }[] } = {
			type: "thinking",
			thinking,
			summaryRanges: [
				{ start: 0, end: 21 },
				{ start: 23, end: thinking.length },
			],
		};
		const message = fauxAssistantMessage([block]);
		const before = JSON.stringify(message);
		const component = new AssistantMessageComponent(message);
		const rows = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(rows.slice(1)).toEqual(["▾  Summary", "   Inspecting inputs", "   Checking output"]);
		expect(JSON.stringify(message)).toBe(before);
	});
	it("retains paragraphs, long content and mixed full thinking at narrow widths", () => {
		const summary = "**Checking a considerably longer heading**\n\nKeep this legitimate paragraph with 界 and café.";
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: summary, summaryRanges: [{ start: 0, end: summary.length }] },
			{ type: "thinking", thinking: "Full first paragraph.\n\nFull second paragraph." },
			{ type: "text", text: "Final answer." },
		]);
		const component = new AssistantMessageComponent(message);
		for (const width of [120, 24, 80]) {
			const rows = component.render(width).map((line) => stripAnsi(line).trimEnd());
			const text = rows.join("\n");
			expect(text).toContain("Summary");
			expect(text).toContain("café.");
			expect(text).toMatch(/Full first\s+paragraph\.\n\n {3}Full second/);
			expect(text).toContain("Final answer.");
			expect(rows.some((line) => line === "")).toBe(true);
		}
	});

	it("leaves unknown thinking unchanged and ignores stale ranges", () => {
		const thinking = "**Brief heading**\n\nFull paragraph.";
		const legacy = fauxAssistantMessage([{ type: "thinking", thinking }]);
		const stale = fauxAssistantMessage([{ type: "thinking", thinking, summaryRanges: [{ start: 0, end: 999 }] }]);
		expect(new AssistantMessageComponent(stale).render(80)).toEqual(new AssistantMessageComponent(legacy).render(80));
		const next: ThinkingContent = {
			type: "thinking",
			thinking: "A later full thinking block must not become part of an invalid summary.",
		};
		const crossing = fauxAssistantMessage([
			{ type: "thinking", thinking: "Short", summaryRanges: [{ start: 0, end: 20 }] },
			next,
		]);
		expect(new AssistantMessageComponent(crossing).render(80).map(stripAnsi).join("\n")).not.toContain("Summary");
	});

	it("renders empty and redacted blocks at zero height", () => {
		for (const block of [
			{ type: "thinking" as const, thinking: " \n\n", summaryRanges: [{ start: 0, end: 3 }] },
			{
				type: "thinking" as const,
				thinking: "redacted placeholder",
				redacted: true,
				thinkingSignature: "opaque-fixture",
			},
		])
			expect(new AssistantMessageComponent(fauxAssistantMessage([block])).render(80)).toEqual([]);
	});

	it("streams without duplicate headings and survives width changes", () => {
		const block: ThinkingContent = { type: "thinking", thinking: "", summaryRanges: [] };
		const message = fauxAssistantMessage([block]);
		const component = new AssistantMessageComponent(message);
		for (const chunk of ["**Inspect", "ing inputs**", "\n\n", "**Checking output**"]) {
			block.thinking += chunk;
			block.summaryRanges = [{ start: 0, end: Math.min(21, block.thinking.length) }];
			if (block.thinking.length > 23) block.summaryRanges.push({ start: 23, end: block.thinking.length });
			component.updateContent(message, true);
			for (const width of [80, 120, 24]) {
				const rows = component.render(width).map((line) => stripAnsi(line).trimEnd());
				expect(rows.filter((line) => line.includes("Summary"))).toHaveLength(1);
				expect(rows.slice(1).every((line) => line.trim().length > 0)).toBe(true);
			}
		}
		component.updateContent(message, false);
		expect(
			component
				.render(80)
				.map((line) => stripAnsi(line).trimEnd())
				.slice(1),
		).toEqual(["▾  Summary", "   Inspecting inputs", "   Checking output"]);
	});
	it("keeps groups separate across tools and never renders replay signatures", () => {
		const block: ThinkingContent = {
			type: "thinking",
			thinking: "Visible",
			summaryRanges: [{ start: 0, end: 7 }],
			thinkingSignature: "opaque-fixture",
		};
		const message = fauxAssistantMessage([
			block,
			{ type: "toolCall", id: "tool1", name: "example", arguments: {} },
			{ ...block, thinking: "Another" },
		]);
		const text = new AssistantMessageComponent(message).render(80).map(stripAnsi).join("\n");
		expect(text.match(/Summary/g)).toHaveLength(2);
		expect(text).toContain("Visible");
		expect(text).toContain("Another");
		expect(text).not.toContain("opaque-fixture");
	});

	it("does not leave a summary label when a Markdown transformer hides its content", () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "Visible", summaryRanges: [{ start: 0, end: 7 }] },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, undefined, undefined, [() => ""]);
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("Summary");
	});
});
