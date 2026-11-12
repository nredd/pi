import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatEntryTimestamp } from "../src/modes/interactive/components/entry-timestamp.ts";

const sideEffects = vi.hoisted(() => ({ copied: [] as string[], opened: [] as string[] }));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: async (text: string) => {
		sideEffects.copied.push(text);
	},
	readClipboardText: async () => null,
	readClipboardFilePaths: async () => null,
}));
vi.mock("../src/utils/open-browser.ts", () => ({
	openBrowser: (url: string) => {
		sideEffects.opened.push(url);
	},
}));
beforeEach(() => {
	sideEffects.copied.length = 0;
	sideEffects.opened.length = 0;
});

async function toggle(host: InteractiveHarness): Promise<void> {
	host.input("/settings");
	host.input("\r");
	await host.settle();
	host.input("Show timestamps");
	host.input("\r");
	await host.settle();
	host.input("\x1b");
	await host.settle();
}

// nredd/pi#30: real editor, settings, streamed tools and replay on an isolated terminal.
describe("interactive timestamps", () => {
	it("excludes timestamp framing from selection and preserves wrapped URL targets and source copy", async () => {
		const url = "https://example.com/one/very/long/path/which/wraps/across/multiple/terminal/rows";
		const source = `before\n\n${url}\n\nafter`;
		const host = await createInteractiveHarness({ columns: 40, rows: 40, settings: { showTimestamps: true } });
		try {
			host.harness.setResponses([fauxAssistantMessage(source, { timestamp: 0 })]);
			await host.harness.session.prompt("go");
			await host.settle();
			const rows = host.viewport();
			const start = rows.findIndex((line) => line.includes("1970-01-01"));
			const end = rows.findIndex((line) => line.includes("after"));
			expect(start).toBeGreaterThan(0);
			expect(end).toBeGreaterThan(start);
			host.input(`\x1b[<0;1;${start + 1}M`);
			host.input(`\x1b[<32;15;${end + 1}M`);
			host.input(`\x1b[<0;15;${end + 1}m`);
			await host.settle();
			const copied = sideEffects.copied.at(-1);
			expect(copied).toContain(url);
			expect(copied).not.toContain("1970-01-01");
			expect(copied).not.toContain("│");
			const urlRow = rows.findIndex((line) => line.includes("https://example.com"));
			host.input(`\x1b[<0;7;${urlRow + 2}M`);
			host.input(`\x1b[<0;7;${urlRow + 2}m`);
			await host.settle();
			expect(sideEffects.opened).toEqual([url]);
			expect(host.harness.session.getLastAssistantText()).toBe(source);
		} finally {
			await host.dispose();
		}
	});
	it("uses the exact recorded completion time for a live user command and replay", async () => {
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			settings: { showTimestamps: true },
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", () => ({
						result: { output: "fixture output", exitCode: 0, cancelled: false, truncated: false },
					}));
				},
			],
		});
		try {
			host.input("!fixture");
			host.input("\r");
			await host.settle();
			const [event] = host.harness.eventsOfType("bash_execution_recorded");
			expect(event).toBeDefined();
			const saved = host.harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "bashExecution");
			expect(saved?.type === "message" && saved.message).toBe(event!.message);
			const label = formatEntryTimestamp(event!.message.timestamp)!;
			expect(host.viewport().some((line) => line.includes(label))).toBe(true);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(host.viewport().some((line) => line.includes(label))).toBe(true);
			expect(host.harness.eventsOfType("bash_execution_recorded")).toHaveLength(1);
		} finally {
			await host.dispose();
		}
	});

	it("uses recorded entry times for custom entries and omits hidden custom messages", async () => {
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			settings: { showTimestamps: true },
			extensionFactories: [
				(pi) => {
					pi.registerEntryRenderer("example", () => new Text("CUSTOM ENTRY", 0, 0));
					pi.on("before_agent_start", () => {
						pi.appendEntry("example", {});
						pi.sendMessage({ customType: "hidden", content: "HIDDEN", display: false });
					});
				},
			],
		});
		try {
			host.harness.setResponses([fauxAssistantMessage("DONE", { timestamp: 0 })]);
			await host.harness.session.prompt("go");
			await host.settle();
			const entry = host.harness.sessionManager
				.getEntries()
				.find((item) => item.type === "custom" && item.customType === "example");
			expect(entry).toBeDefined();
			const expected = formatEntryTimestamp(Date.parse(entry!.timestamp))!;
			const rows = host.viewport();
			const row = rows.findIndex((line) => line.includes("CUSTOM ENTRY"));
			expect(rows[row - 1]).toContain(expected);
			expect(rows.some((line) => line.includes("HIDDEN"))).toBe(false);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			const replay = host.viewport();
			expect(replay[replay.findIndex((line) => line.includes("CUSTOM ENTRY")) - 1]).toContain(expected);
		} finally {
			await host.dispose();
		}
	});
	it.each([
		[80, 24],
		[120, 40],
	])("shares live and replay labels at %ix%i without changing disclosure", async (columns, rows) => {
		const recorded = Date.parse("2020-01-02T03:04:05Z");
		const next = recorded + 10000;
		const host = await createInteractiveHarness({
			columns,
			rows,
			settings: { hideThinkingBlock: true, showTimestamps: true },
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition("/tmp", {
							operations: {
								exec: async (_command, _cwd, { onData }) => {
									onData(Buffer.from("one\ntwo\nthree\n"));
									return { exitCode: 0 };
								},
							},
						}),
					);
				},
			],
		});
		try {
			host.harness.setResponses([
				fauxAssistantMessage(
					[
						fauxThinking("Think first. Then run."),
						fauxText("INTRO"),
						fauxToolCall("bash", { command: "example" }),
					],
					{ timestamp: recorded, stopReason: "toolUse" },
				),
				fauxAssistantMessage("DONE", { timestamp: next }),
			]);
			await host.harness.session.prompt("go");
			await host.settle();
			const label = formatEntryTimestamp(recorded)!;
			const finalLabel = formatEntryTimestamp(next)!;
			const live = host.viewport();
			expect(live.filter((line) => line.includes(label))).toHaveLength(2);
			expect(live.filter((line) => line.includes(finalLabel))).toHaveLength(1);
			const header = live.findIndex((line) => /^▸ +\$ example/.test(line));
			expect(header, live.join("\n")).toBeGreaterThan(0);
			host.input(`\x1b[<0;7;${header + 1}M`);
			host.input(`\x1b[<0;7;${header + 1}m`);
			await host.settle();
			expect(host.viewport().some((line) => /^▾ +\$ example/.test(line))).toBe(true);
			await toggle(host);
			expect(host.harness.settingsManager.getShowTimestamps()).toBe(false);
			expect(host.viewport().some((line) => line.includes(label))).toBe(false);
			expect(host.viewport().some((line) => /^▾ +\$ example/.test(line))).toBe(true);
			await toggle(host);
			expect(host.viewport().some((line) => /^▾ +\$ example/.test(line))).toBe(true);
			host.input("\x0f");
			await host.settle();
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(2);
			expect(host.viewport().filter((line) => line.includes(finalLabel))).toHaveLength(1);
			host.resize(40, rows);
			await host.settle();
			expect(host.viewport().some((line) => line.includes(finalLabel))).toBe(true);
			host.resize(20, rows);
			await host.settle();
			expect(host.viewport().some((line) => line.includes(finalLabel))).toBe(false);
		} finally {
			await host.dispose();
		}
	});
});
