import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { describe, expect, it } from "vitest";

function rowOf(host: InteractiveHarness, pattern: RegExp): number {
	const row = host.viewport().findIndex((line) => pattern.test(line));
	expect(row, host.viewport().join("\n")).toBeGreaterThanOrEqual(0);
	return row;
}

async function click(host: InteractiveHarness, row: number): Promise<void> {
	host.input(`\x1b[<0;7;${row + 1}M`);
	host.input(`\x1b[<0;7;${row + 1}m`);
	await host.settle();
}

// Promise barriers replace the Python scenario's sleep 6, not the real tool/UI lifecycle.
describe("interactive disclosure", () => {
	it("raw click toggles disclosure but drag does not", async () => {
		const host = await createInteractiveHarness({
			columns: 120,
			rows: 40,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition("/tmp", {
							operations: {
								exec: async (_command, _cwd, { onData }) => {
									onData(Buffer.from("a\nb\nc\n"));
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
				fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'a\\nb\\nc\\n'" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ALL TOOLS DONE"),
			]);
			await host.harness.session.prompt("go");
			await host.settle();
			const pattern = /^▸ +\$ printf .*· 3 lines output/;
			await click(host, rowOf(host, pattern));
			const header = rowOf(host, /^▾ +\$ printf/);
			expect(
				host
					.viewport()
					.slice(header, header + 8)
					.some((line) => line.trim() === "c"),
			).toBe(true);
			await click(host, header);
			const collapsed = rowOf(host, pattern);
			host.input(`\x1b[<0;5;${collapsed + 1}M`);
			host.input(`\x1b[<32;31;${collapsed + 1}M`);
			host.input(`\x1b[<0;31;${collapsed + 1}m`);
			await host.settle();
			expect(host.viewport().some((line) => /^▾ +\$ printf/.test(line))).toBe(false);
			expect(host.viewport()[collapsed]).toMatch(pattern);
		} finally {
			await host.dispose();
		}
	});

	it("running row toggles before held tool settles", async () => {
		let release!: () => void;
		let started!: () => void;
		let stream!: () => void;
		const streaming = new Promise<void>((resolve) => {
			stream = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const host = await createInteractiveHarness({
			columns: 140,
			rows: 90,
			extensionFactories: [
				(pi) => {
					pi.registerTool(
						createBashToolDefinition("/tmp", {
							operations: {
								exec: async (_command, _cwd, { onData }) => {
									started();
									await streaming;
									onData(Buffer.from("output so far\nsecond line\n"));
									await held;
									onData(Buffer.from("last line\n"));
									return { exitCode: 0 };
								},
							},
						}),
					);
				},
			],
		});
		let turn: Promise<void> | undefined;
		try {
			host.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "held tool" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("TRANSCRIPT DONE"),
			]);
			turn = host.harness.session.prompt("go");
			await ready;
			await host.settle();
			const row = rowOf(host, /held tool.*Elapsed/);
			expect(host.viewport()[row]).toMatch(/^▸ /);
			await click(host, row);
			await click(host, rowOf(host, /^▾ .*held tool/));
			expect(host.viewport()[row]).toMatch(/^▸ .*held tool.*Elapsed/);
			stream();
			await host.settle();
			await click(host, row);
			expect(host.viewport().some((line) => line.includes("output so far"))).toBe(true);
			await click(host, rowOf(host, /^▾ .*held tool/));
			release();
			await turn;
			await host.settle();
			expect(host.viewport().some((line) => line.includes("TRANSCRIPT DONE"))).toBe(true);
			const finalRow = rowOf(host, /^▸ .*held tool.*3 lines output/);
			const promptRow = rowOf(host, /^\s*go\s*$/);
			const finalProse = rowOf(host, /^│ TRANSCRIPT DONE$/);
			// Complete one-line oracle for this fixture: no output outside the sole entry.
			expect(
				host
					.viewport()
					.slice(promptRow + 1, finalProse)
					.filter((line) => line.trim() && !/^┄+$/.test(line)),
			).toEqual([host.viewport()[finalRow]]);
			expect(host.viewport()[finalRow + 1]).toBe("┄".repeat(140));
			await click(host, finalRow);
			expect(host.viewport().filter((line) => line.startsWith("▾ "))).toHaveLength(1);
			rowOf(host, /^▾ .*held tool/);
			expect(host.viewport().some((line) => line.trim() === "last line")).toBe(true);
			await click(host, rowOf(host, /^▾ .*held tool/));
			expect(host.viewport().filter((line) => line.startsWith("▾ "))).toHaveLength(0);
			expect(host.viewport()[finalRow + 1]).toBe("┄".repeat(140));
		} finally {
			stream();
			release();
			await turn;
			await host.dispose();
		}
	});
});
