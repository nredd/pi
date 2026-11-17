import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";
import { serializeSessionBranch } from "../src/core/session-export.ts";

// Synthetic terminal proof for https://github.com/nredd/pi/issues/111. No provider or credentials.
describe("interactive summary rendering", () => {
	// Regression: #111, per-part trimming must not reinterpret code as emphasis.
	it("preserves Markdown whitespace in later summaries and mixed full thinking", async () => {
		const host = await createInteractiveHarness({ columns: 80, rows: 50, settings: { hideThinkingBlock: false } });
		const first = "First";
		const later = "    **literal**";
		const full = "    **full literal**\n\nFull line  \nNext line";
		const fenced = "```text\n  **fenced literal**  \n```";
		const thinking = [first, later, full, fenced].join("\n\n");
		const message = fauxAssistantMessage([
			{
				type: "thinking",
				thinking,
				summaryRanges: [
					{ start: 0, end: first.length },
					{ start: 7, end: 7 + later.length },
					{ start: thinking.length - fenced.length, end: thinking.length },
				],
				thinkingSignature: "opaque-whitespace-fixture",
			},
			fauxText("FINAL ANSWER"),
		]);
		try {
			host.harness.setResponses([message]);
			await host.harness.session.prompt("synthetic Markdown whitespace fixture");
			for (const columns of [80, 120, 28, 80]) {
				host.resize(columns, 50);
				await host.settle();
				const rows = host.viewport();
				const start = rows.findIndex((line) => line.includes("Summary"));
				const end = rows.findIndex((line) => line.includes("FINAL ANSWER"));
				expect(start).toBeGreaterThanOrEqual(0);
				const rendered = rows.slice(start, end - 1).join("\n");
				for (const literal of ["**literal**", "**full literal**", "**fenced literal**"]) {
					expect(rendered).toContain(literal);
					const row = rows.findIndex((line) => line.includes(literal));
					expect(
						host.terminal
							.getStyledLine(row)
							.filter((cell) => cell.text.trim())
							.some((cell) => cell.bold),
					).toBe(false);
				}
				expect(rendered).toMatch(/Full line\n +Next line/);
				expect(rendered).not.toContain("opaque-whitespace-fixture");
				expect(rendered).toMatchSnapshot(`markdown-whitespace-${columns}`);
			}
			const recorded = host.harness.session.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(
				recorded?.type === "message" && recorded.message.role === "assistant" && recorded.message.content,
			).toEqual(message.content);
		} finally {
			await host.dispose();
		}
	});
	it("paints adjacent summaries at 80/120 columns, resizes, and preserves recorded content", async () => {
		const host = await createInteractiveHarness({ columns: 80, rows: 50, settings: { hideThinkingBlock: false } });
		const parts = [
			"**Inspecting inputs**",
			"**Checking boundaries**",
			"**Preparing results**",
			"A longer visible summary explains why the result remains complete when the terminal is resized to a narrow width.",
		];
		let offset = 0;
		const message = fauxAssistantMessage([
			{
				type: "thinking",
				thinking: parts.join("\n\n"),
				summaryRanges: parts.map((part) => {
					const range = { start: offset, end: offset + part.length };
					offset = range.end + 2;
					return range;
				}),
				thinkingSignature: "opaque-fixture",
			},
			fauxText("FINAL ANSWER"),
		]);
		try {
			host.harness.setResponses([message, fauxAssistantMessage("SECOND ANSWER")]);
			await host.harness.session.prompt("synthetic rendering fixture");
			for (const columns of [80, 120, 28, 80]) {
				host.resize(columns, 50);
				await host.settle();
				const rows = host.viewport();
				const start = rows.findIndex((line) => line.includes("Summary"));
				const end = rows.findIndex((line) => line.includes("FINAL ANSWER"));
				expect(start, rows.join("\n")).toBeGreaterThanOrEqual(0);
				const summaryRows = rows.slice(start, end - 1);
				expect(summaryRows.every((line) => line.trim().length > 0)).toBe(true);
				expect(summaryRows.filter((line) => line.includes("Summary"))).toHaveLength(1);
				expect(summaryRows.join("\n")).not.toContain("opaque-fixture");
				if (columns !== 28) expect(summaryRows.join("\n")).toMatchSnapshot(`summary-${columns}`);
				const heading = host.terminal.getStyledLine(start + 1);
				expect(heading.filter((cell) => cell.text.trim()).every((cell) => cell.bold)).toBe(true);
			}
			const recorded = host.harness.session.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(
				recorded?.type === "message" && recorded.message.role === "assistant" && recorded.message.content,
			).toEqual(message.content);
			const exported = serializeSessionBranch(host.harness.session.sessionManager);
			expect(exported).toContain("summaryRanges");
			expect(exported).not.toContain('"Summary"');
			expect(serializeConversation([message])).toBe("[Assistant]: FINAL ANSWER");
			await host.harness.session.prompt("second fixture");
			await host.settle();
			expect(host.viewport().filter((line) => line.includes("Summary"))).toHaveLength(1);
		} finally {
			await host.dispose();
		}
	});
});
