import {
	createInteractiveHarness,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
} from "@earendil-works/pi-coding-agent/testing";
import { describe, expect, it } from "vitest";

// Ports test_transcript_framing.py's complete viewport/style assertions.
describe("interactive framing", () => {
	it("thinking headline paints bold without delimiters", async () => {
		const host = await createInteractiveHarness({ columns: 120, rows: 50, settings: { hideThinkingBlock: true } });
		try {
			host.harness.setResponses([
				fauxAssistantMessage([fauxThinking("**Evaluating commit strategy**\nThen verify."), fauxText("PROSE ONE")]),
			]);
			await host.harness.session.prompt("first");
			await host.settle();
			const row = host.viewport().findIndex((line) => line.startsWith("▸ Thinking"));
			expect(host.viewport()[row], host.viewport().join("\n")).toBe("▸ Thinking · Evaluating commit strategy");
			const cells = host.terminal.getStyledLine(row);
			const text = cells.map((cell) => cell.text).join("");
			expect(text).not.toContain("**");
			const start = text.indexOf("Evaluating");
			expect(start).toBeGreaterThan(0);
			expect(cells.slice(start, start + "Evaluating commit strategy".length).every((cell) => cell.bold)).toBe(true);
		} finally {
			await host.dispose();
		}
	});

	it("two turns frame roles and separators exactly", async () => {
		const host = await createInteractiveHarness({ columns: 120, rows: 50, settings: { hideThinkingBlock: true } });
		try {
			host.harness.setResponses([
				fauxAssistantMessage([
					fauxThinking("Check the notes first. Then answer."),
					fauxText("PROSE ONE\n\nsecond paragraph"),
				]),
				fauxAssistantMessage("PROSE TWO"),
			]);
			await host.harness.session.prompt("first");
			await host.harness.session.prompt("second");
			await host.settle();
			const rows = host.viewport();
			expect(rows, rows.join("\n")).toContain("│ PROSE ONE");
			expect(rows).toContain("│ second paragraph");
			expect(rows).toContain("│ PROSE TWO");
			expect(rows).toContain("▸ Thinking · Check the notes first.");
			const thinking = rows.findIndex((line) => line.startsWith("▸ Thinking"));
			expect(rows[thinking + 1]).toBe("┄".repeat(120));
			expect(rows[thinking + 2]).toBe("│ PROSE ONE");
			const first = rows.findIndex((line) => /^\s*first\s*$/.test(line));
			const second = rows.findIndex((line) => /^\s*second\s*$/.test(line));
			expect(first).toBeGreaterThanOrEqual(0);
			expect(second).toBeGreaterThan(first);
			const rules = rows.flatMap((line, index) => (line === "─".repeat(120) && index < second ? [index] : []));
			expect(rules.length).toBeGreaterThan(0);
			expect(rules[rules.length - 1]).toBeGreaterThan(first);
			expect(rules.some((index) => index < first)).toBe(false);
		} finally {
			await host.dispose();
		}
	});
});
