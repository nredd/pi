import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Markdown,
	resetCapabilitiesCache,
	setCapabilities,
	stripTerminalSequences,
	Text,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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

	// nredd/pi#30: transformed-empty Markdown must not reveal independent entry framing.
	it.each([false, true])("keeps transformed-empty user content hidden with timestamps %s", (enabled) => {
		let calls = 0;
		const component = new UserMessageComponent("hidden", undefined, 1, [
			() => {
				calls++;
				return "";
			},
		]);
		const markdown = component.children.find((child) => child instanceof Markdown)!;
		const render = vi.spyOn(markdown, "render");
		component.entryTimestamp.setTime({ messageTimestamp: 0 });
		component.entryTimestamp.setEnabled(enabled);
		expect(component.render(80)).toEqual([]);
		component.entryTimestamp.setEnabled(!enabled);
		expect(component.render(80)).toEqual([]);
		expect(calls).toBe(1);
		expect(render).toHaveBeenCalledTimes(2);
		expect(component.children).toContain(markdown);
		expect(component.render(120)).toEqual([]);
		expect(calls).toBe(2);
		expect(render).toHaveBeenCalledTimes(3);
	});

	it.each([false, true])("follows actual transformed user content through reflow with timestamps %s", (enabled) => {
		const component = new UserMessageComponent("visible at narrow widths", undefined, 1, [
			(text, context) => (context.availableWidth > 100 ? "" : text),
		]);
		component.entryTimestamp.setTime({ messageTimestamp: 0 });
		component.entryTimestamp.setEnabled(enabled);
		const visible = component.render(80);
		expect(visible).toHaveLength(3);
		expect(visible.join("\n").match(timestampPattern)?.length ?? 0).toBe(enabled ? 1 : 0);
		expect(component.render(120)).toEqual([]);
		expect(component.render(80)).toEqual(visible);
	});

	it.each([false, true])("keeps transformed-empty assistant framing undecorated (multiple=%s)", (multiple) => {
		let calls = 0;
		const component = new AssistantMessageComponent(
			{
				...message,
				content: multiple
					? [
							{ type: "text", text: "hidden" },
							{ type: "thinking", thinking: "hidden thought" },
							{ type: "text", text: "hidden too" },
						]
					: [{ type: "text", text: "hidden" }],
			},
			false,
			undefined,
			undefined,
			1,
			[
				() => {
					calls++;
					return "";
				},
			],
		);
		const baseline = component.render(80);
		expect(baseline).toHaveLength(multiple ? 2 : 1); // Keep the original separators.
		component.entryTimestamp.setEnabled(true);
		expect(component.render(80)).toEqual(baseline);
		expect(calls).toBe(multiple ? 3 : 1);
	});

	it.each(["entry", "message"] as const)("keeps empty custom %s framing undecorated", (kind) => {
		let calls = 0;
		const body = {
			render: () => {
				calls++;
				return [];
			},
			invalidate: () => {},
		};
		const component =
			kind === "entry"
				? new CustomEntryComponent(
						{
							type: "custom",
							id: "hidden",
							parentId: null,
							timestamp: "2020-01-02T03:04:05Z",
							customType: "example",
							data: {},
						},
						() => body,
					)
				: new CustomMessageComponent(
						{ role: "custom", customType: "example", content: "source", display: true, timestamp: 0 },
						() => body,
					);
		component.setExpanded(true);
		const baseline = component.render(80);
		expect(baseline).toHaveLength(1); // Preserve the pre-existing separator, not a timestamp-only entry.
		expect(calls).toBe(1);
		component.entryTimestamp.setEnabled(true);
		calls = 0;
		expect(component.render(80)).toEqual(baseline);
		expect(calls).toBe(1);
	});

	it("uses diagnostic padding for an otherwise empty interrupted assistant entry", () => {
		const component = new AssistantMessageComponent({ ...message, content: [], stopReason: "aborted" });
		const baseline = component.render(80);
		component.entryTimestamp.setEnabled(true);
		const decorated = component.render(80);
		expect(decorated).toHaveLength(baseline.length);
		expect(decorated.slice(1)).toEqual(baseline.slice(1));
		expect(decorated.join("\n").match(timestampPattern)).toHaveLength(1);
		component.entryTimestamp.setEnabled(false);
		expect(component.render(80)).toEqual(baseline);
	});

	it("reuses skill invocation padding without changing its expanded state", () => {
		const component = new SkillInvocationMessageComponent({
			name: "fixture",
			location: "/fixture",
			content: "details",
			userMessage: undefined,
		});
		component.setExpanded(true);
		const baseline = component.render(80);
		component.entryTimestamp.setTime({ messageTimestamp: 0 });
		component.entryTimestamp.setEnabled(true);
		const decorated = component.render(80);
		expect(decorated).toHaveLength(baseline.length);
		expect(decorated.slice(1)).toEqual(baseline.slice(1));
		expect(decorated.join("\n").match(timestampPattern)).toHaveLength(1);
		component.entryTimestamp.setEnabled(false);
		expect(component.render(80)).toEqual(baseline);
	});

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

	it.each(["default", "self"] as const)(
		"preserves tool instances, one-line rows, disclosure, and cached renderers with %s shell",
		(renderShell) => {
			let calls = 0;
			const ui = { requestRender: () => {} } as unknown as TUI;
			const component = new ToolExecutionComponent(
				"example",
				"call-1",
				{},
				{},
				{
					renderShell,
					renderCall: () => {
						calls++;
						return new Text("call", 0, 0);
					},
					renderResult: (_result, { expanded }) => new Text(expanded ? "result\\nmore details" : "summary", 0, 0),
				},
				ui,
				process.cwd(),
			);
			component.entryTimestamp.setTime({ messageTimestamp: 0 });
			component.updateResult({ content: [{ type: "text", text: "result\\nmore details" }], isError: false });
			const baseline = component.render(80);
			const renderCalls = calls;
			component.entryTimestamp.setEnabled(true);
			expect(component).toBeInstanceOf(ToolExecutionComponent);
			expect(component.render(80)).toHaveLength(2);
			expect(component.render(80).slice(1)).toEqual(baseline.slice(1));
			expect(calls).toBe(renderCalls);
			component.setExpanded(true);
			const expanded = component.render(80);
			component.entryTimestamp.setEnabled(false);
			expect(component.render(80).slice(1)).toEqual(expanded.slice(1));
			component.entryTimestamp.setEnabled(true);
			expect(component.render(80)).toEqual(expanded);
			component.updateResult({ content: [{ type: "text", text: "updated" }], isError: false });
			expect(component.render(80).join("\n").match(timestampPattern)).toHaveLength(1);
		},
	);

	it("retains inline image placement and native image instances across timestamp toggles", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const component = new ToolExecutionComponent(
				"image",
				"image-call",
				{},
				{},
				undefined,
				{ requestRender: () => {} } as unknown as TUI,
				process.cwd(),
			);
			component.entryTimestamp.setTime({ messageTimestamp: 0 });
			component.setExpanded(true);
			component.updateResult({
				content: [
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
					},
				],
				isError: false,
			});
			const baseline = component.render(120);
			component.entryTimestamp.setEnabled(true);
			const decorated = component.render(120);
			expect(decorated).toHaveLength(baseline.length);
			expect(decorated.slice(1)).toEqual(baseline.slice(1));
			expect(decorated.some((line) => line.includes("iVBORw0KGgo"))).toBe(true);
		} finally {
			resetCapabilitiesCache();
		}
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
