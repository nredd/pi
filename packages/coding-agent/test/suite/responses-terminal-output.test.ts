/** Regression nredd/pi#45: a malformed terminal snapshot cannot settle as a successful tool-free final. */
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
let h: Harness | undefined;
afterEach(async () => {
	await h?.session.abort();
	h?.cleanup();
	h = undefined;
	vi.restoreAllMocks();
});

it.each([
	{
		type: "message",
		id: "msg_fixture",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "fixture", annotations: [] }],
	},
	{
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		name: "fixture",
		arguments: "{}",
		status: "completed",
	},
])("settles terminal-only $type as an error without executing a tool or retrying", async (item) => {
	const wire = `data: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response: { id: "resp_fixture", status: "completed", output: [item] } })}\n\n`;
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
	let calls = 0;
	const outcomes: string[] = [];
	h = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "fixture",
					label: "Fixture",
					description: "Synthetic execution counter",
					parameters: Type.Object({}),
					execute: async () => {
						calls++;
						return { content: [{ type: "text", text: "ok" }], details: undefined };
					},
				});
				pi.on("agent_before_settle", (event) => {
					outcomes.push(event.outcome);
				});
			},
		],
	});
	await h.session.bindExtensions({ mode: "print" });
	h.session.agent.streamFunction = (_model, context, options) =>
		stream(model, context, { ...options, apiKey: "fixture-key" });
	await h.session.prompt("fixture");
	expect(outcomes).toEqual(["error"]);
	expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	expect(h.eventsOfType("auto_retry_start")).toHaveLength(0);
	expect(
		h
			.eventsOfType("message_end")
			.filter(({ message }) => message.role === "assistant")
			.map(({ message }) => message),
	).toMatchObject([{ role: "assistant", stopReason: "error", rawStopReason: "completed", content: [] }]);
	expect(calls).toBe(0);
	expect(fetch).toHaveBeenCalledTimes(1);
});
