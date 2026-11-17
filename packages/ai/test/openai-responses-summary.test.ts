import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "synthetic",
	name: "Synthetic",
	api: "openai-responses",
	provider: "example",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1,
	};
}

// Regression: https://github.com/nredd/pi/issues/111
describe("Responses summary provenance", () => {
	it("marks streamed and finalized parts while preserving replay bytes", async () => {
		const message = output();
		const parts = ["**Inspecting inputs**", "A long summary.\n\nA legitimate paragraph."];
		const item: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_test",
			summary: parts.map((text) => ({ type: "summary_text", text })),
			encrypted_content: "opaque-fixture",
		};
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 0,
				item: { ...item, summary: [] },
			};
			for (const [summary_index, text] of parts.entries()) {
				yield {
					type: "response.reasoning_summary_text.delta",
					output_index: 0,
					item_id: item.id,
					sequence_number: 1,
					summary_index,
					delta: text,
				};
				const block = message.content[0];
				expect(block.type).toBe("thinking");
				if (block.type !== "thinking") throw new Error("Missing thinking block");
				expect(block.summaryRanges).toHaveLength(summary_index + 1);
				const range = block.summaryRanges![summary_index];
				expect(block.thinking.slice(range.start, range.end)).toBe(text);
				yield {
					type: "response.reasoning_summary_part.done",
					output_index: 0,
					item_id: item.id,
					sequence_number: 2,
					summary_index,
					part: { type: "summary_text", text },
				};
			}
			yield { type: "response.output_item.done", output_index: 0, sequence_number: 3, item };
			yield {
				type: "response.completed",
				sequence_number: 4,
				response: { id: "resp_test", status: "completed", output: [item] },
			} as ResponseStreamEvent;
		}
		await processResponsesStream(events(), message, new AssistantMessageEventStream(), model);
		expect(message.content[0]).toMatchObject({
			thinking: parts.join("\n\n"),
			summaryRanges: [
				{ start: 0, end: parts[0].length },
				{ start: parts[0].length + 2, end: parts.join("\n\n").length },
			],
		});
		const replay = convertResponsesMessages(model, normalizeContext({ messages: [message] }), new Set());
		expect(replay).toEqual([item]);
	});
	it("does not classify full reasoning from the same protocol as a summary", async () => {
		const message = output();
		const item: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_full",
			summary: [],
			content: [{ type: "reasoning_text", text: "Full paragraph.\n\nAnother paragraph." }],
		};
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield { type: "response.output_item.added", output_index: 0, sequence_number: 0, item };
			yield {
				type: "response.reasoning_text.delta",
				output_index: 0,
				item_id: item.id,
				sequence_number: 1,
				content_index: 0,
				delta: "Full paragraph.",
			};
			expect(message.content[0]).not.toHaveProperty("summaryRanges");
			yield { type: "response.output_item.done", output_index: 0, sequence_number: 2, item };
			yield {
				type: "response.completed",
				sequence_number: 3,
				response: { id: "resp_full", status: "completed", output: [item] },
			} as ResponseStreamEvent;
		}
		await processResponsesStream(events(), message, new AssistantMessageEventStream(), model);
		expect(message.content[0]).toMatchObject({ thinking: "Full paragraph.\n\nAnother paragraph." });
		expect(message.content[0]).not.toHaveProperty("summaryRanges");
	});

	it("retains exact provenance across interrupted mixed streams and delta boundaries", async () => {
		const message = output();
		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 0,
				item: { type: "reasoning", id: "rs_mixed", summary: [] },
			};
			yield {
				type: "response.reasoning_text.delta",
				output_index: 0,
				item_id: "rs_mixed",
				sequence_number: 1,
				content_index: 0,
				delta: "Full text.\n\n",
			};
			for (const delta of ["Visible ", "summary"])
				yield {
					type: "response.reasoning_summary_text.delta",
					output_index: 0,
					item_id: "rs_mixed",
					sequence_number: 2,
					summary_index: 0,
					delta,
				};
			yield {
				type: "response.reasoning_summary_part.done",
				output_index: 0,
				item_id: "rs_mixed",
				sequence_number: 3,
				summary_index: 0,
				part: { type: "summary_text", text: "Visible summary" },
			};
			yield {
				type: "response.reasoning_text.delta",
				output_index: 0,
				item_id: "rs_mixed",
				sequence_number: 4,
				content_index: 1,
				delta: "More full text.",
			};
		}
		await expect(processResponsesStream(events(), message, new AssistantMessageEventStream(), model)).rejects.toThrow(
			"terminal response event",
		);
		expect(message.content[0]).toEqual({
			type: "thinking",
			thinking: "Full text.\n\nVisible summary\n\nMore full text.",
			summaryRanges: [{ start: 12, end: 27 }],
		});
	});
});
