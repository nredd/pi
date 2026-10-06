import { Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { isEntryRule } from "../src/modes/interactive/components/entry-rule.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		component.setExpanded(true);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("▾  custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: true, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("▾ custom")),
		).toBe(true);
	});

	test.each([40, 80, 200])("collapses a rendered message to its first line at width %i", (width) => {
		initTheme("dark");
		const renderer: MessageRenderer = (_message, options) =>
			new Text(options.expanded ? "✓ agent done\nstats\npreview" : `✓ agent done ${"x".repeat(300)}\nmore`, 1, 1);
		const component = new CustomMessageComponent(message("custom"), renderer, undefined, 1);

		const rows = component
			.render(width)
			.map(stripAnsi)
			.filter((line) => line.trim().length > 0 && !isEntryRule(line));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/^▸ ✓ agent done x+…$/);
		expect(visibleWidth(component.render(width).at(-1) ?? "")).toBeLessThanOrEqual(width);
	});

	test("toggles a rendered message on click and leaves the entry rule inert", () => {
		initTheme("dark");
		const renderer: MessageRenderer = (_message, options) =>
			new Text(options.expanded ? "head\nbody line" : "head", 0, 0);
		const component = new CustomMessageComponent(message("custom"), renderer, undefined, 1);
		const width = 80;
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 4,
			y: 0,
			screenX: 4,
			screenY: 0,
			width,
			height: component.render(width).length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};

		expect(component.handleMouse(click)).toBeUndefined();
		expect(component.handleMouse({ ...click, y: 1, screenY: 1 })?.handled).toBe(true);
		const expanded = component.render(width).map(stripAnsi);
		expect(expanded.join("\n")).toContain("body line");
		expect(expanded[1]).toMatch(/^▾ head/);

		expect(component.handleMouse({ ...click, y: 2, screenY: 2, height: expanded.length })?.handled).toBe(true);
		expect(component.render(width).map(stripAnsi).join("\n")).not.toContain("body line");
	});

	test("leaves messages without a renderer unchanged", () => {
		initTheme("dark");
		const component = new CustomMessageComponent(message("line one\n\nline two"), undefined, undefined, 1);
		const rendered = component.render(80).map(stripAnsi).join("\n");
		expect(rendered).toContain("[test]");
		expect(rendered).toContain("line two");
		expect(rendered).not.toMatch(/[▸▾]/);
	});
});

function message(content: string): CustomMessage {
	return { role: "custom", customType: "test", content, display: true, timestamp: Date.now() };
}
