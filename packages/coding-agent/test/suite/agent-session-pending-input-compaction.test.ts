import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// Refs nredd/pi-harness#751: protect the whole unsent batch, not just its final context message.
describe("pending input during threshold compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const h of harnesses.splice(0)) h.cleanup();
	});

	it("preserves pending input after a pre-dispatch gate fails and retries", async () => {
		const instruction = "VERBATIM_GATE_RETRY";
		const context = `GATED_CONTEXT:${"x".repeat(8000)}`;
		let gates = 0;
		const h = await createHarness({
			tools: [],
			useModelRuntimeStream: true,
			settings: { compaction: { targetTokens: 100, keepRecentTokens: 1 }, retry: { baseDelayMs: 1 } },
			prepareRequest: () => ({
				beforeProviderRequest: async () => {
					if (++gates === 1) throw new Error("overloaded_error");
					return () => {};
				},
			}),
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "context", content: context, display: false },
					}));
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		let actualInput: string[] = [];
		h.setResponses([
			(request) => {
				actualInput = request.messages.map(getMessageText);
				return fauxAssistantMessage("done", { timestamp: Date.now() + 1000 });
			},
		]);
		await h.session.prompt(instruction);
		expect(actualInput).toContain(instruction);
		expect(actualInput).toContain(context);
		expect(gates).toBe(2);
		expect(h.faux.state.callCount).toBe(1);
	});

	for (const routed of [false, true]) {
		for (const history of [false, true]) {
			it.each(["user", "custom"] as const)(
				`preserves exact ${routed ? "routed" : "direct"} %s input with history=${history}`,
				async (kind) => {
					const instruction = "VERBATIM_SENTINEL: preserve every instruction, including this punctuation!";
					const context = `UNSENT_CONTEXT:${"x".repeat(8000)}`;
					let dispatched = false;
					let summarizedPending = false;
					let summarizedAfterDispatch = false;
					const h = await createHarness({
						tools: [],
						settings: { compaction: { targetTokens: 100, keepRecentTokens: 1 } },
						extensionFactories: [
							(pi) => {
								pi.registerVirtualModel({
									provider: "router",
									id: "pending",
									name: "Pending",
									route(_request, ctx) {
										return { model: ctx.modelRegistry.find("faux", "faux-1")!, thinkingLevel: "off" };
									},
								});
								pi.on("before_agent_start", () => ({
									message: { customType: "context", content: context, display: false },
								}));
								pi.on("session_before_compact", (event) => {
									const summarized = JSON.stringify([
										event.preparation.messagesToSummarize,
										event.preparation.turnPrefixMessages,
									]);
									if (!dispatched)
										summarizedPending ||=
											summarized.includes(instruction) || summarized.includes("UNSENT_CONTEXT:");
									else summarizedAfterDispatch ||= summarized.includes(instruction);
									return {
										compaction: {
											summary: "checkpoint",
											firstKeptEntryId: event.preparation.firstKeptEntryId,
											tokensBefore: event.preparation.tokensBefore,
										},
									};
								});
							},
						],
					});
					harnesses.push(h);
					if (history) {
						for (const text of ["old one", "old two"]) {
							h.sessionManager.appendMessage({
								role: "user",
								content: text.repeat(500),
								timestamp: Date.now() - 2000,
							});
							h.sessionManager.appendMessage(
								fauxAssistantMessage("old answer", { timestamp: Date.now() - 1000 }),
							);
						}
						h.session.refreshContext();
					}
					if (routed) await h.session.setModel(h.session.modelRuntime.getModel("router", "pending")!);
					let actualInput: string[] = [];
					h.setResponses([
						(request) => {
							dispatched = true;
							actualInput = request.messages.map(getMessageText);
							return fauxAssistantMessage("done", { timestamp: Date.now() + 1000 });
						},
					]);
					if (kind === "user") await h.session.prompt(instruction);
					else
						await h.session.sendCustomMessage(
							{ customType: "request", content: instruction, display: false },
							{ triggerTurn: true },
						);
					expect(actualInput).toContain(instruction);
					expect(actualInput).toContain(context);
					expect(summarizedPending).toBe(false);
					expect(summarizedAfterDispatch).toBe(true);
					expect(h.faux.state.callCount).toBe(1);
					expect(h.eventsOfType("compaction_start").length).toBeLessThanOrEqual(3);
				},
			);
		}
	}
});
