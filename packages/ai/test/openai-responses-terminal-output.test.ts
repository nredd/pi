/** Regression nredd/pi#45: terminal snapshots cannot silently supply unobserved output. */
import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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
const items = [
	{
		type: "message",
		id: "msg_fixture",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "private fixture text", annotations: [] }],
	},
	{
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		name: "fixture",
		arguments: "{}",
		status: "completed",
	},
	{
		type: "custom_tool_call",
		id: "ctc_fixture",
		call_id: "call_fixture",
		name: "fixture",
		input: "private fixture input",
	},
	{ type: "reasoning", id: "rs_fixture", summary: [] },
] satisfies ResponseOutputItem[];
const failure = "OpenAI Responses terminal output was not finalized by output_item.done";

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "pending",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Partial wire fixtures deliberately omit unrelated response metadata. */
async function* events(values: object[]): AsyncIterable<ResponseStreamEvent> {
	for (const [sequence_number, value] of values.entries()) yield { ...value, sequence_number } as ResponseStreamEvent;
}
const terminal = (output: ResponseOutputItem[]) => ({
	type: "response.completed",
	response: { id: "resp_fixture", status: "completed", output },
});
const done = (item: ResponseOutputItem) => ({ type: "response.output_item.done", output_index: 0, item });

afterEach(() => vi.restoreAllMocks());

describe("terminal Responses output validation", () => {
	it.each(items)("rejects terminal-only $type without echoing content or identifiers", async (item) => {
		await expect(
			processResponsesStream(events([terminal([item])]), output(), new AssistantMessageEventStream(), model),
		).rejects.toThrow(failure);
	});

	it.each(items)("preserves finalized $type without requiring earlier added/delta events", async (item) => {
		const message = output();
		await processResponsesStream(
			events([done(item), terminal([item])]),
			message,
			new AssistantMessageEventStream(),
			model,
		);
		expect(message.content).toHaveLength(1);
		expect(message.stopReason).toBe(
			item.type === "function_call" || item.type === "custom_tool_call" ? "toolUse" : "stop",
		);
	});

	it("rejects an added text item whose final text exists only in the terminal snapshot", async () => {
		const item = items[0];
		await expect(
			processResponsesStream(
				events([{ type: "response.output_item.added", output_index: 0, item }, terminal([item])]),
				output(),
				new AssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow(failure);
	});

	it("does not mistake a finalized different item for the missing item", async () => {
		await expect(
			processResponsesStream(
				events([done({ ...items[0], id: "msg_other" }), terminal([items[0]])]),
				output(),
				new AssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow(failure);
	});

	it.each([undefined, ""])("rejects a supported terminal item with invalid id %s", async (id) => {
		await expect(
			processResponsesStream(
				events([{ type: "response.completed", response: { status: "completed", output: [{ ...items[0], id }] } }]),
				output(),
				new AssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow(failure);
	});

	it("requires the same item type even when the id matches", async () => {
		await expect(
			processResponsesStream(
				events([done({ ...items[1], id: items[0].id }), terminal([items[0]])]),
				output(),
				new AssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow(failure);
	});

	it("does not mark a mismatched slot finalized", async () => {
		await expect(
			processResponsesStream(
				events([
					{ type: "response.output_item.added", output_index: 0, item: items[1] },
					done(items[0]),
					terminal([items[0]]),
				]),
				output(),
				new AssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow(failure);
	});

	it("retains incomplete response semantics instead of reporting a successful missing item", async () => {
		const message = output();
		await processResponsesStream(
			events([
				{
					type: "response.incomplete",
					response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: items },
				},
			]),
			message,
			new AssistantMessageEventStream(),
			model,
		);
		expect(message.stopReason).toBe("length");
		expect(message.rawStopReason).toBe("incomplete.max_output_tokens");
	});

	it("preserves genuinely empty completed responses", async () => {
		const message = output();
		await processResponsesStream(events([terminal([])]), message, new AssistantMessageEventStream(), model);
		expect(message.content).toEqual([]);
		expect(message.stopReason).toBe("stop");
	});

	it("ignores server-side items that do not map to assistant content", async () => {
		const message = output();
		await processResponsesStream(
			events([
				done({
					type: "web_search_call",
					id: "ws_fixture",
					status: "completed",
					action: { type: "search", query: "fixture" },
				}),
				terminal([
					{
						type: "web_search_call",
						id: "ws_fixture",
						status: "completed",
						action: { type: "search", query: "fixture" },
					},
				]),
			]),
			message,
			new AssistantMessageEventStream(),
			model,
		);
		expect(message.content).toEqual([]);
		expect(message.stopReason).toBe("stop");
	});

	it("emits one error final from the real wrapper instead of a successful empty message", async () => {
		const wire = `data: ${JSON.stringify({ ...terminal([items[1]]), sequence_number: 0 })}\n\n`;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(wire, { headers: { "content-type": "text/event-stream" } }));
		const response = streamResponses(
			model,
			normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }),
			{ apiKey: "fixture-key" },
		);
		const types: string[] = [];
		for await (const event of response) types.push(event.type);
		const message = await response.result();
		expect(types).toEqual(["start", "error"]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(failure);
		expect(message.rawStopReason).toBe("completed");
		expect(message.content).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
