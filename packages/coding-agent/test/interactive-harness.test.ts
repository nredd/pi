import { ExtensionStartupError } from "@earendil-works/pi-coding-agent";
import { createInteractiveHarness, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

describe("interactive extension host", () => {
	it("cleans up a fatal startup and supports the next host", async () => {
		const listeners = process.listenerCount("SIGINT");
		await expect(
			createInteractiveHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							throw new ExtensionStartupError("blocked startup");
						});
					},
				],
			}),
		).rejects.toThrow("blocked startup");
		expect(process.listenerCount("SIGINT")).toBe(listeners);
		const host = await createInteractiveHarness({ columns: 200, gitBranch: "frozen-branch" });
		try {
			expect(host.viewport().join("\n")).toContain("frozen-branch");
		} finally {
			await host.dispose();
		}
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	});

	it("retains the runtime transport across reload and new", async () => {
		const host = await createInteractiveHarness({ useModelRuntimeStream: true });
		try {
			for (const command of ["/reload", "/new"]) {
				host.input(command);
				host.input("\r");
				await host.settle();
				host.harness.setResponses([fauxAssistantMessage(`reply after ${command}`)]);
				await host.harness.session.prompt("continue");
				await host.settle();
				expect(host.viewport().join("\n")).toContain(`reply after ${command}`);
			}
		} finally {
			await host.dispose();
		}
	});

	it("renders real footer, widget and custom overlay and reloads factories exactly once", async () => {
		for (const tuiMode of ["fullscreen", "regular"] as const) {
			let factories = 0;
			let starts = 0;
			let footersDisposed = 0;
			const host = await createInteractiveHarness({
				columns: 80,
				rows: 24,
				tuiMode,
				extensionFactories: [
					(pi) => {
						factories++;
						pi.on("session_start", (_event, ctx) => {
							starts++;
							ctx.ui.setFooter(() =>
								Object.assign(new Text("TEST FOOTER", 0, 0), {
									dispose: () => {
										footersDisposed++;
									},
								}),
							);
							ctx.ui.setWidget("proof", ["TEST WIDGET"]);
						});
						pi.registerCommand("overlay", {
							handler: async (_args, ctx) => {
								await ctx.ui.custom<void>(
									(_ui, _theme, _keys, done) => ({
										render: () => ["TEST OVERLAY"],
										invalidate() {},
										handleInput: () => done(),
									}),
									{ overlay: true },
								);
							},
						});
					},
				],
			});
			try {
				expect(factories).toBe(1);
				expect(starts).toBe(1);
				expect(host.viewport().join("\n")).toContain("TEST FOOTER");
				expect(host.viewport().join("\n")).toContain("TEST WIDGET");
				host.input("/overlay");
				host.input("\r");
				await host.settle();
				expect(host.viewport().join("\n")).toContain("TEST OVERLAY");
				host.input("x");
				await host.settle();
				expect(host.viewport().join("\n")).not.toContain("TEST OVERLAY");
				const before = host.harness.session;
				host.input("/reload");
				host.input("\r");
				await host.settle();
				expect(host.harness.session).toBe(before);
				expect(factories).toBe(2);
				expect(starts).toBe(2);
				expect(footersDisposed).toBe(1);
				host.input("/new");
				host.input("\r");
				await host.settle();
				expect(host.harness.session).not.toBe(before);
				expect(factories).toBe(3);
				expect(starts).toBe(3);
				expect(footersDisposed).toBe(2);
				expect(host.viewport().join("\n")).toContain("TEST FOOTER");
				expect(host.viewport().join("\n")).toContain("TEST WIDGET");
				host.harness.setResponses([fauxAssistantMessage("after replacement")]);
				await host.harness.session.prompt("new turn");
				await host.settle();
				expect(host.viewport().join("\n")).toContain("after replacement");
				host.resize(60, 20);
				await host.settle();
				expect(host.viewport()).toHaveLength(20);
				expect(host.viewport().join("\n")).toContain("TEST FOOTER");
			} finally {
				await host.dispose();
			}
			expect(footersDisposed).toBe(3);
		}
	});
});
