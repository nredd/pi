import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { beforeEach, expect, it, vi } from "vitest";

const clipboard = vi.hoisted(() => ({ copies: [] as string[] }));
vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: async (text: string) => {
		clipboard.copies.push(text);
	},
	readClipboardText: async () => null,
	readClipboardFilePaths: async () => null,
}));
beforeEach(() => {
	clipboard.copies.length = 0;
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

// #35: assert actual selected text, not merely preservation of internal coordinates.
it.each([120, 40, 20])(
	"preserves multi-entry selection through timestamp off/on toggles at width %s",
	async (columns) => {
		const host = await createInteractiveHarness({
			columns,
			rows: 40,
			settings: { fullscreenCopyOnSelect: false },
		});
		try {
			host.harness.setResponses([
				fauxAssistantMessage(`FIRST BODY ${"selection-word ".repeat(6).trim()}`),
				fauxAssistantMessage("SECOND BODY"),
			]);
			await host.harness.session.prompt("first prompt");
			await host.harness.session.prompt("second prompt");
			await host.settle();
			const rows = host.viewport();
			const start = rows.findIndex((line) => line.includes("FIRST BODY"));
			const end = rows.findIndex((line) => line.includes("SECOND BODY"));
			expect(start).toBeGreaterThan(0);
			expect(end).toBeGreaterThan(start);
			host.input(`\x1b[<0;3;${start + 1}M`);
			host.input(`\x1b[<32;13;${end + 1}M`);
			host.input(`\x1b[<0;13;${end + 1}m`);
			await host.settle();
			expect(clipboard.copies).toHaveLength(0);
			host.input("\x18");
			await host.settle();
			const selected = clipboard.copies.at(-1)!;
			expect(selected).toContain("FIRST BODY");
			expect(selected).toContain("second prompt");
			expect(selected).toContain("SECOND BODY");
			expect(selected).not.toMatch(/[┄─│]|\d{4}-\d{2}-\d{2}/);
			for (const enabled of [true, false, true]) {
				const copies = clipboard.copies.length;
				await toggle(host);
				expect(host.harness.settingsManager.getShowTimestamps()).toBe(enabled);
				if (columns === 20) expect(host.viewport().join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
				expect(clipboard.copies).toHaveLength(copies);
				host.input("\x18");
				await host.settle();
				expect(clipboard.copies.at(-1)).toBe(selected);
			}
			for (const width of [20, 40, 80]) {
				const copies = clipboard.copies.length;
				host.resize(width, 40);
				await host.settle();
				expect(clipboard.copies).toHaveLength(copies);
				host.input("\x18");
				await host.settle();
				expect(clipboard.copies.at(-1)).toBe(selected);
			}
		} finally {
			await host.dispose();
		}
	},
);

// #35: real disclosure above a partial selection maps it; changing selected tool detail invalidates it.
it("retains text below real tool disclosure but clears changed selected detail", async () => {
	const host = await createInteractiveHarness({
		columns: 80,
		rows: 40,
		settings: { fullscreenCopyOnSelect: false },
		extensionFactories: [
			(pi) =>
				pi.registerTool(
					createBashToolDefinition("/tmp", {
						operations: {
							exec: async (_command, _cwd, { onData }) => {
								onData(Buffer.from("one\ntwo\nthree\n"));
								return { exitCode: 0 };
							},
						},
					}),
				),
		],
	});
	try {
		host.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "fixture" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("SECOND BODY"),
		]);
		await host.harness.session.prompt("go");
		await host.settle();
		const row = host.viewport().findIndex((line) => line.includes("SECOND BODY"));
		expect(row).toBeGreaterThan(0);
		host.input(`\x1b[<0;3;${row + 1}M`);
		host.input(`\x1b[<32;8;${row + 1}M`);
		host.input(`\x1b[<0;8;${row + 1}m`);
		await host.settle();
		for (const expanded of [true, false, true]) {
			const copies = clipboard.copies.length;
			host.input("\x0f");
			await host.settle();
			expect(host.viewport().some((line) => /^▾ .*fixture/.test(line))).toBe(expanded);
			expect(clipboard.copies).toHaveLength(copies);
			host.input("\x18");
			await host.settle();
			expect(clipboard.copies.at(-1)).toBe("SECOND");
		}
		const rows = host.viewport();
		const start = rows.findIndex((line) => line.includes("one"));
		const end = rows.findIndex((line) => line.includes("SECOND BODY"));
		expect(start).toBeGreaterThan(0);
		host.input(`\x1b[<0;3;${start + 1}M`);
		host.input(`\x1b[<32;8;${end + 1}M`);
		host.input(`\x1b[<0;8;${end + 1}m`);
		await host.settle();
		const copies = clipboard.copies.length;
		host.input("\x0f");
		await host.settle();
		expect(clipboard.copies).toHaveLength(copies);
		host.input("\x18");
		await host.settle();
		expect(clipboard.copies.at(-1)).toBe("SECOND BODY");
	} finally {
		await host.dispose();
	}
});
