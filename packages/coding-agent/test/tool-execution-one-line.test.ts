import { resetCapabilitiesCache, setCapabilities, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tui = { requestRender: () => {} } as unknown as TUI;
const cwd = process.cwd();

type Result = Parameters<ToolExecutionComponent["updateResult"]>[0];

function custom(overrides: Partial<ToolDefinition>): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom_tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		...overrides,
	};
}

function text(value: string, isError = false): Result {
	return { content: [{ type: "text", text: value }], details: undefined, isError };
}

interface Case {
	title: string;
	build: () => ToolExecutionComponent;
	/** Expected stripped row at a width wide enough to avoid truncation. */
	row: RegExp;
}

const cases: Case[] = [
	{
		title: "bash output",
		build: () => {
			const c = new ToolExecutionComponent(
				"bash",
				"b",
				{ command: "ls -la" },
				{},
				createBashToolDefinition(cwd),
				tui,
				cwd,
			);
			c.updateResult(text("a\nb\nc"));
			return c;
		},
		row: /^▸ +\$ ls -la · 3 lines output · .*to expand$/,
	},
	{
		title: "bash error",
		build: () => {
			const c = new ToolExecutionComponent(
				"bash",
				"be",
				{ command: "false" },
				{},
				createBashToolDefinition(cwd),
				tui,
				cwd,
			);
			c.updateResult(text("\nboom\nmore", true));
			return c;
		},
		row: /^▸ +\$ false · boom$/,
	},
	{
		title: "read",
		build: () => {
			const c = new ToolExecutionComponent(
				"read",
				"r",
				{ path: "x.txt" },
				{},
				createReadToolDefinition(cwd),
				tui,
				cwd,
			);
			c.updateResult(text("hello\nworld"));
			return c;
		},
		row: /^▸ +read x\.txt/,
	},
	{
		title: "edit",
		build: () => {
			const c = new ToolExecutionComponent(
				"edit",
				"e",
				{ path: "x.txt", edits: [{ oldText: "a", newText: "b" }] },
				{},
				createEditToolDefinition(cwd),
				tui,
				cwd,
			);
			c.updateResult({ ...text("ok"), details: { diff: "-1 a\n+1 b" } });
			return c;
		},
		row: /^▸ +edit x\.txt · \+1 -1 · .*to expand$/,
	},
	{
		title: "write before its result",
		build: () =>
			new ToolExecutionComponent(
				"write",
				"w",
				{ path: "x.txt", content: "one\ntwo\n" },
				{},
				createWriteToolDefinition(cwd),
				tui,
				cwd,
			),
		row: /^ +write x\.txt · 2 lines/,
	},
	{
		title: "custom renderer with tree glyphs",
		build: () => {
			const c = new ToolExecutionComponent(
				"todo",
				"t",
				{},
				{},
				custom({
					renderCall: () => new Text("todo list", 0, 0),
					renderResult: () => new Text("  └─ 3 tasks\n  ├─ one", 0, 0),
				}),
				tui,
				cwd,
			);
			c.updateResult(text("x"));
			return c;
		},
		row: /^▸ +todo list · 3 tasks$/,
	},
	{
		title: "self-rendered shell",
		build: () => {
			const c = new ToolExecutionComponent(
				"Agent",
				"a",
				{},
				{},
				custom({
					renderShell: "self",
					renderCall: () => new Text("Plan  audit things", 0, 0),
					renderResult: () => new Text("done\nmore", 0, 0),
				}),
				tui,
				cwd,
			);
			c.updateResult(text("x"));
			return c;
		},
		row: /^▸ +Plan {2}audit things · done$/,
	},
	{
		title: "partial with an empty renderer",
		build: () => {
			const c = new ToolExecutionComponent(
				"custom_tool",
				"p",
				{},
				{},
				custom({ renderCall: () => new Text("streaming", 0, 0), renderResult: () => new Text("", 0, 0) }),
				tui,
				cwd,
			);
			c.updateResult(text("first\nlatest\n"), true);
			return c;
		},
		row: /^ +streaming · latest$/,
	},
	{
		title: "no result",
		build: () =>
			new ToolExecutionComponent(
				"custom_tool",
				"n",
				{},
				{},
				custom({ renderCall: () => new Text("waiting", 0, 0) }),
				tui,
				cwd,
			),
		row: /^ +waiting$/,
	},
	{
		title: "text fallback with many lines",
		build: () => {
			const c = new ToolExecutionComponent("mystery", "f", { a: 1 }, {}, custom({}), tui, cwd);
			c.updateResult(text("l1\nl2\nl3"));
			return c;
		},
		row: /^▸ +mystery a=1 · 3 lines$/,
	},
	{
		title: "text fallback with one line",
		build: () => {
			const c = new ToolExecutionComponent("mystery", "f1", { a: 1 }, {}, custom({}), tui, cwd);
			c.updateResult(text("only line\n"));
			return c;
		},
		row: /^▸ +mystery a=1 · only line$/,
	},
	{
		title: "unknown tool without a definition",
		build: () => {
			const c = new ToolExecutionComponent("ghost", "g", { a: 1 }, {}, undefined, tui, cwd);
			c.updateResult(text("l1\nl2"));
			return c;
		},
		row: /^▸ +ghost a=1 · 2 lines$/,
	},
];

function contentRows(component: ToolExecutionComponent, width: number): string[] {
	return component.render(width).filter((line) => stripAnsi(line).trim().length > 0);
}

describe("collapsed tool rows", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		resetCapabilitiesCache();
	});

	for (const testCase of cases) {
		test.each([40, 80, 200])(`${testCase.title} is one line at width %i`, (width) => {
			const rows = contentRows(testCase.build(), width);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
			if (width === 200) {
				expect(stripAnsi(rows[0]!).trimEnd()).toMatch(testCase.row);
			}
		});

		test(`${testCase.title} still expands to the full render`, () => {
			const component = testCase.build();
			component.setExpanded(true);
			expect(contentRows(component, 200).length).toBeGreaterThanOrEqual(1);
		});
	}

	test("colors the first error line with the error color", () => {
		const component = cases.find((c) => c.title === "bash error")!.build();
		expect(component.render(200).join("\n")).toContain(theme.fg("error", "boom"));
	});

	test("keeps the summary visible when the call is long", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"long",
			{ command: `echo ${"x".repeat(300)}` },
			{},
			createBashToolDefinition(cwd),
			tui,
			cwd,
		);
		component.updateResult(text("a\nb"));
		const row = stripAnsi(contentRows(component, 80)[0]!);
		expect(row).toContain("…");
		expect(row).toContain("2 lines output");
	});

	test("hides images until expanded", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = new ToolExecutionComponent("custom_tool", "img", {}, {}, undefined, tui, cwd);
		component.updateResult({
			content: [{ type: "image", data: "final-png", mimeType: "image/png" }],
			isError: false,
		});
		expect(component.render(120).join("\n")).not.toContain("final-png");
		component.setExpanded(true);
		expect(component.render(120).join("\n")).toContain("final-png");
	});

	test("renders nothing when every part is empty", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"empty",
			{},
			{},
			custom({ renderCall: () => new Text("", 0, 0), renderResult: () => new Text("", 0, 0) }),
			tui,
			cwd,
		);
		component.updateResult(text(""));
		expect(component.render(120)).toEqual([]);
	});
});
