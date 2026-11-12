import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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
	// nredd/pi#30: a transformer-hidden prompt stays hidden through settings and canonical replay.
	it("does not reveal transformed-away user content through toggles and replay", async () => {
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			extensionFactories: [
				(pi) =>
					pi.registerMarkdownTransformer((text, context) =>
						context.messageType === "user" && text === "HIDDEN PROMPT" ? "" : text,
					),
			],
		});
		try {
			host.harness.setResponses([fauxAssistantMessage("VISIBLE REPLY", { timestamp: 0 })]);
			await host.harness.session.prompt("HIDDEN PROMPT");
			await host.settle();
			const user = host.harness.session.messages.find((entry) => entry.role === "user");
			const hiddenLabel = formatEntryTimestamp(user!.timestamp)!;
			const replyLabel = formatEntryTimestamp(0)!;
			expect(host.viewport().join("\n")).not.toContain("HIDDEN PROMPT");
			for (const reload of [false, true]) {
				if (reload) {
					host.input("/reload");
					host.input("\r");
					await host.settle();
				}
				await toggle(host);
				expect(host.viewport().join("\n")).toContain(replyLabel);
				expect(host.viewport().join("\n")).not.toContain(hiddenLabel);
				await toggle(host);
				expect(host.viewport().join("\n")).not.toContain(replyLabel);
				expect(host.viewport().join("\n")).not.toContain(hiddenLabel);
			}
		} finally {
			await host.dispose();
		}
	});

	it("uses the owning assistant when a provider emits a complete tool call without deltas", async () => {
		const timestamp = Date.parse("2000-06-01T12:34:56Z");
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			useModelRuntimeStream: true,
			settings: { showTimestamps: true },
			extensionFactories: [
				(pi) =>
					pi.registerTool(
						createBashToolDefinition("/tmp", { operations: { exec: async () => ({ exitCode: 0 }) } }),
					),
			],
		});
		try {
			const model = host.harness.getModel();
			let calls = 0;
			host.harness.session.modelRuntime.registerProvider(model.provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "faux",
				models: [model],
				streamSimple: () => {
					const first = calls++ === 0;
					const message = first
						? fauxAssistantMessage([fauxToolCall("bash", { command: "fixture" })], {
								timestamp,
								stopReason: "toolUse",
							})
						: fauxAssistantMessage("DONE", { timestamp: 0 });
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
					stream.end();
					return stream;
				},
			});
			await host.harness.session.prompt("go");
			await host.settle();
			expect(host.harness.eventsOfType("message_update")).toHaveLength(0);
			const label = formatEntryTimestamp(timestamp)!;
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(1);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(1);
		} finally {
			await host.dispose();
		}
	});
	it.each([false, true])("retains recorded custom-message time through replay (queued=%s)", async (queued) => {
		let release!: () => void;
		let started!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const host = await createInteractiveHarness({ columns: 120, rows: 40, settings: { showTimestamps: true } });
		let turn: Promise<void> | undefined;
		try {
			if (queued) {
				host.harness.setResponses([
					async () => {
						started();
						await held;
						return fauxAssistantMessage("DONE", { timestamp: 0 });
					},
				]);
				turn = host.harness.session.prompt("go");
				await ready;
			}
			const timestamp = Date.parse("2000-06-01T12:34:56Z");
			const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
			try {
				await host.harness.session.sendCustomMessage(
					{ customType: "recorded", content: "CUSTOM RECORDED", display: true },
					{ triggerTurn: false },
				);
			} finally {
				clock.mockRestore();
			}
			release();
			await turn;
			await host.settle();
			const event = host.harness
				.eventsOfType("message_recorded")
				.find((item) => item.message.role === "custom" && item.message.customType === "recorded");
			expect(event).toBeDefined();
			expect(Date.parse(event!.entry.timestamp)).toBe(timestamp);
			expect(event!.message.timestamp).toBe(timestamp);
			const label = formatEntryTimestamp(timestamp)!;
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(1);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(1);
		} finally {
			release();
			await turn;
			await host.dispose();
		}
	});
	it("retains call-context labels when parallel tools finish out of order", async () => {
		let release!: () => void;
		let fastDone!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const finished = new Promise<void>((resolve) => {
			fastDone = resolve;
		});
		const timestamp = Date.parse("2020-06-01T12:30:00Z");
		const label = formatEntryTimestamp(timestamp)!;
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			settings: { showTimestamps: true },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						...createBashToolDefinition("/tmp", {
							operations: {
								exec: async (command, _cwd, { onData }) => {
									onData(Buffer.from("started\n"));
									if (command === "slow") await held;
									else fastDone();
									return { exitCode: 0 };
								},
							},
						}),
						executionMode: "parallel",
					});
				},
			],
		});
		let turn: Promise<void> | undefined;
		try {
			host.harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "slow" }), fauxToolCall("bash", { command: "fast" })],
					{ timestamp, stopReason: "toolUse" },
				),
				fauxAssistantMessage("DONE", { timestamp: 0 }),
			]);
			turn = host.harness.session.prompt("go");
			await finished;
			await host.settle();
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(2);
			release();
			await turn;
			await host.settle();
			const ends = host.harness.eventsOfType("tool_execution_end");
			expect(ends.map((event) => event.toolCallId)).toEqual([
				host.harness.eventsOfType("tool_execution_start").find((event) => event.args.command === "fast")!
					.toolCallId,
				host.harness.eventsOfType("tool_execution_start").find((event) => event.args.command === "slow")!
					.toolCallId,
			]);
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(2);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			expect(host.viewport().filter((line) => line.includes(label))).toHaveLength(2);
		} finally {
			release();
			await turn;
			await host.dispose();
		}
	});
	it("shares canonical persisted ISO fallback between live assistant/tool rows and replay", async () => {
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			settings: { showTimestamps: true },
			extensionFactories: [
				(pi) =>
					pi.registerTool(
						createBashToolDefinition("/tmp", { operations: { exec: async () => ({ exitCode: 0 }) } }),
					),
			],
		});
		try {
			host.harness.setResponses([
				fauxAssistantMessage([fauxText("FALLBACK INTRO"), fauxToolCall("bash", { command: "fixture" })], {
					timestamp: NaN,
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("FALLBACK DONE", { timestamp: 0 }),
			]);
			await host.harness.session.prompt("go");
			await host.settle();
			const event = host.harness
				.eventsOfType("message_recorded")
				.find((item) => item.message.role === "assistant" && !Number.isFinite(item.message.timestamp));
			expect(event).toBeDefined();
			const label = formatEntryTimestamp(Date.parse(event!.entry.timestamp))!;
			const live = host.viewport();
			const intro = live.findIndex((line) => line.includes("FALLBACK INTRO"));
			const call = live.findIndex((line) => line.includes("$ fixture"));
			expect(live[intro - 1]).toContain(label);
			expect(live[call - 1]).toContain(label);
			host.input("/reload");
			host.input("\r");
			await host.settle();
			const replay = host.viewport();
			expect(replay[replay.findIndex((line) => line.includes("FALLBACK INTRO")) - 1]).toContain(label);
			expect(replay[replay.findIndex((line) => line.includes("$ fixture")) - 1]).toContain(label);
		} finally {
			await host.dispose();
		}
	});
	it.each(["plain", "osc8"] as const)(
		"excludes metadata from selection and preserves wrapped %s URLs and source copy",
		async (kind) => {
			const url = "https://example.com/one/very/long/path/which/wraps/across/multiple/terminal/rows";
			const source = `before\n\n${kind === "osc8" ? `[${url}](${url})` : url}\n\nafter`;
			const host = await createInteractiveHarness({
				columns: 40,
				rows: 40,
				settings: { showTimestamps: true, terminal: { hyperlinks: kind === "osc8" } },
			});
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
				host.input("/copy");
				host.input("\r");
				await host.settle();
				expect(sideEffects.copied.at(-1)).toBe(source);
			} finally {
				await host.dispose();
			}
		},
	);
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
		[80, 24, "auto"],
		[120, 40, "auto"],
		[80, 24, "always"],
		[120, 40, "always"],
		[80, 24, "hidden"],
		[120, 40, "hidden"],
	] as const)("shares live/replay labels at %ix%i with %s scrollbar", async (columns, rows, fullscreenScrollbar) => {
		const recorded = Date.parse("2020-01-02T03:04:05Z");
		const next = recorded + 10000;
		const host = await createInteractiveHarness({
			columns,
			rows,
			settings: { hideThinkingBlock: true, showTimestamps: true, fullscreenScrollbar },
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
