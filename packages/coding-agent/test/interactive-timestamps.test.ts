import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { describe, expect, it } from "vitest";
import { formatEntryTimestamp } from "../src/modes/interactive/components/entry-timestamp.ts";

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
