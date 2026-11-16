import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionStartupError } from "../../src/core/extensions/startup-error.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

function gate(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// #110: the public extension signal belongs to the session run, not a single provider loop.
describe("session run cancellation ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rejects the whole boundary dispatch after reload, including remaining old handlers", async () => {
		const entered = gate();
		const release = gate();
		let laterHandlers = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async () => {
						entered.resolve();
						await release.promise;
						return { entries: [{ type: "custom", customType: "stale-proposal", data: true }], continue: true };
					});
					pi.on("agent_before_settle", () => {
						laterHandlers++;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			await harness.session.reload();
			release.resolve();
			await run;
			expect(laterHandlers).toBe(0);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "stale-proposal"),
			).toBe(false);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("exposes cancellation synchronously while run preparation is paused", async () => {
		const entered = gate();
		const release = gate();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not dispatch")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			const abort = harness.session.abort();
			expect(signal?.aborted).toBe(true);
			release.resolve();
			await Promise.all([run, abort]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.extensionRunner.createContext().signal).toBeUndefined();
		} finally {
			release.resolve();
			await run;
		}
	});

	it("rejects proposals when a settle hook aborts synchronously", async () => {
		let aborted: boolean | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (_event, ctx) => {
						ctx.abort();
						aborted = ctx.signal?.aborted;
						return { entries: [{ type: "custom", customType: "canceled", data: true }], continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("start");
		expect(aborted).toBe(true);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("lets an awaited cooperative settle handler suppress its notice", async () => {
		const entered = gate();
		const release = gate();
		const notices: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async (event, ctx) => {
						const signal = ctx.signal;
						entered.resolve();
						await release.promise;
						if (signal?.aborted) return;
						ctx.ui.notify("recovering");
						const failed = event.context.contextEntries.at(-1);
						if (!failed) throw new Error("missing response");
						return {
							entries: [{ type: "context_edit", targetId: failed.sourceEntry.id, replacement: null }],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({
				notify: (message) => {
					notices.push(message);
				},
			}),
		});
		harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "invalid_api_key" })]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			const abort = harness.session.abort();
			release.resolve();
			await Promise.all([run, abort]);
			expect(notices).toEqual([]);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("rejects drafts when cancellation follows handler resolution before commit", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (_event, ctx) => {
						// Runs after this handler returns, before emitBoundary's awaited preview completes.
						queueMicrotask(() => ctx.abort());
						return {
							entries: [
								{ type: "custom_message", customType: "canceled", content: "must not commit", display: false },
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("start");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not roll back a committed batch after a late abort and still flushes queued passive context", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						pi.sendMessage(
							{ customType: "passive", content: "independent queued context", display: false },
							{ triggerTurn: false },
						);
						return {
							entries: [
								{ type: "custom", customType: "committed", data: true },
								{
									type: "custom_message",
									customType: "committed-context",
									content: "already committed",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom" && event.entry.customType === "committed")
				void harness.session.abort();
		});
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must not run")]);
		await harness.session.prompt("start");
		expect(harness.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom", customType: "committed" }),
				expect.objectContaining({ type: "custom_message", customType: "committed-context" }),
				expect.objectContaining({ type: "custom_message", customType: "passive" }),
			]),
		);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps one signal across tools and repeated boundary continuations, then retires it without aborting", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const settledSignals: Array<AbortSignal | undefined> = [];
		let continued = false;
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("turn_end", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("agent_before_settle", (_event, ctx) => {
						signals.push(ctx.signal);
						if (continued) return;
						continued = true;
						return {
							entries: [{ type: "custom_message", customType: "continue", content: "next", display: false }],
							continue: true,
						};
					});
					pi.on("agent_settled", (_event, ctx) => {
						settledSignals.push(ctx.signal);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first done"),
			fauxAssistantMessage("boundary done"),
			fauxAssistantMessage("new run"),
		]);
		expect(harness.session.extensionRunner.createContext().signal).toBeUndefined();
		await harness.session.prompt("start");
		const first = signals[0];
		expect(first).toBeDefined();
		expect(signals.length).toBeGreaterThan(6);
		expect(signals.every((signal) => signal === first)).toBe(true);
		expect(first?.aborted).toBe(false);
		expect(settledSignals).toEqual([undefined]);
		signals.length = 0;
		await harness.session.prompt("independent");
		expect(signals[0]).toBeDefined();
		expect(signals[0]).not.toBe(first);
		await harness.session.abort();
		expect(first?.aborted).toBe(false);
		expect(signals[0]?.aborted).toBe(false);
	});

	it("retains the run signal through a retry wait and cancels it before the next dispatch", async () => {
		const retrying = gate();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", (_event, ctx) => {
						signal = ctx.signal;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retrying.resolve();
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not run"),
		]);
		const run = harness.session.prompt("start");
		await retrying.promise;
		expect(harness.session.extensionRunner.createContext().signal).toBe(signal);
		const abort = harness.session.abort();
		expect(signal?.aborted).toBe(true);
		await Promise.all([run, abort]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps the same signal through automatic recovery compaction and retry", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("agent_start", (_event, ctx) => {
						signals.push(ctx.signal);
					});
					pi.on("session_before_compact", (event, ctx) => {
						signals.push(ctx.signal);
						expect(event.signal).not.toBe(ctx.signal);
						return {
							compaction: {
								summary: "recovered",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("agent_before_settle", (_event, ctx) => {
						signals.push(ctx.signal);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "length" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("x".repeat(5_000));
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(signals[0]).toBeDefined();
		expect(signals).toHaveLength(5);
		expect(signals.every((signal) => signal === signals[0])).toBe(true);
		expect(signals[0]?.aborted).toBe(false);
	});

	it("aborts an active owner on fatal startup", async () => {
		const entered = gate();
		const release = gate();
		let emission = 0;
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						if (++emission === 2) throw new ExtensionStartupError("fatal during preparation");
					});
					pi.on("before_agent_start", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			await expect(harness.session.bindExtensions({})).rejects.toThrow("fatal during preparation");
			expect(signal?.aborted).toBe(true);
			release.resolve();
			await run;
			expect(harness.session.extensionRunner.createContext().signal).toBeUndefined();
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("retires ownership when admission fails after preparation", async () => {
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						signal = ctx.signal;
					});
				},
			],
		});
		harnesses.push(harness);
		await expect(
			harness.session.prompt("start", {
				preflightResult: () => {
					throw new Error("admission failed");
				},
			}),
		).rejects.toThrow("admission failed");
		expect(signal).toBeDefined();
		expect(harness.session.extensionRunner.createContext().signal).toBeUndefined();
		expect(harness.session.isIdle).toBe(true);
	});

	it("clears the owner when prompt preparation rejects", async () => {
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						signal = ctx.signal;
					});
				},
			],
		});
		harnesses.push(harness);
		await expect(
			harness.session.prompt("start", {
				images: [
					{
						type: "image",
						mimeType: "image/png",
						get data(): string {
							throw new Error("invalid image input");
						},
					},
				],
			}),
		).rejects.toThrow("invalid image input");
		expect(signal).toBeDefined();
		expect(harness.session.extensionRunner.createContext().signal).toBeUndefined();
		expect(harness.session.isIdle).toBe(true);
	});

	it("disposes a run paused in preparation without dispatching or leaving an idle waiter", async () => {
		const entered = gate();
		const release = gate();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await release.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			const idle = harness.session.waitForIdle();
			harness.session.dispose();
			expect(signal?.aborted).toBe(true);
			release.resolve();
			await Promise.all([run, idle]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.isIdle).toBe(true);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("retires the disposed owner and discards an uncooperative pending proposal", async () => {
		const entered = gate();
		const release = gate();
		let signal: AbortSignal | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async (_event, ctx) => {
						signal = ctx.signal;
						entered.resolve();
						await release.promise;
						return { entries: [{ type: "custom", customType: "disposed", data: true }], continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			harness.session.dispose();
			expect(signal?.aborted).toBe(true);
			expect(() => harness.session.extensionRunner.createContext().signal).toThrow("stale");
			release.resolve();
			await run;
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")).toBe(false);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("does not let an old run finalizer clear the owner of deferred settled work", async () => {
		const entered = gate();
		const release = gate();
		const signals: Array<AbortSignal | undefined> = [];
		let triggered = false;
		let starts = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						signals.push(ctx.signal);
						if (++starts === 2) {
							entered.resolve();
							await release.promise;
						}
					});
					pi.on("agent_settled", (_event, ctx) => {
						expect(ctx.signal).toBeUndefined();
						if (!triggered) {
							triggered = true;
							pi.sendUserMessage("deferred");
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);
		const run = harness.session.prompt("start");
		try {
			await entered.promise;
			expect(signals[1]).toBeDefined();
			expect(signals[1]).not.toBe(signals[0]);
			const abort = harness.session.abort();
			expect(signals[1]?.aborted).toBe(true);
			expect(signals[0]?.aborted).toBe(false);
			release.resolve();
			await Promise.all([run, abort]);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("keeps sibling cancellation independent when sessions share a model runtime", async () => {
		const entered = [gate(), gate()];
		const release = gate();
		const signals: Array<AbortSignal | undefined> = [];
		const factory = (index: number) => (pi: ExtensionAPI) => {
			pi.on("agent_before_settle", async (_event, ctx) => {
				signals[index] = ctx.signal;
				entered[index].resolve();
				await release.promise;
			});
		};
		const first = await createHarness({ extensionFactories: [factory(0)] });
		harnesses.push(first);
		const second = await createHarness({
			fauxProvider: first.faux,
			modelRuntime: first.session.modelRuntime,
			extensionFactories: [factory(1)],
		});
		harnesses.push(second);
		first.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const runs = [first.session.prompt("first"), second.session.prompt("second")];
		try {
			await Promise.all(entered.map((item) => item.promise));
			const abort = first.session.abort();
			expect(signals[0]?.aborted).toBe(true);
			expect(signals[1]?.aborted).toBe(false);
			expect(signals[0]).not.toBe(signals[1]);
			release.resolve();
			await Promise.all([...runs, abort]);
			expect(first.eventsOfType("agent_settled").at(-1)?.aborted).toBe(true);
			expect(second.eventsOfType("agent_settled").at(-1)?.aborted).toBe(false);
		} finally {
			release.resolve();
			await Promise.all(runs);
		}
	});
});
