import { describe, expect, it } from "vitest";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const context = normalizeContext({
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

async function capture(
	run: (onPayload: (request: unknown) => never) => { result(): Promise<unknown> },
): Promise<{ reasoning?: { summary?: string } }> {
	let payload: unknown;
	await run((request) => {
		payload = request;
		throw new Error("payload captured");
	}).result();
	return payload as { reasoning?: { summary?: string } };
}

describe("reasoning summary default", () => {
	it("requests a detailed summary from the Codex Responses API unless told otherwise", async () => {
		const model = getModel("openai-codex", "gpt-6-sol")!;
		const run = (reasoningSummary?: "concise") => (onPayload: (r: unknown) => never) =>
			streamCodex(model, context, { apiKey: mockToken(), reasoningEffort: "high", reasoningSummary, onPayload });
		expect((await capture(run())).reasoning?.summary).toBe("detailed");
		expect((await capture(run("concise"))).reasoning?.summary).toBe("concise");
	});

	it("requests a detailed summary from the OpenAI Responses API unless told otherwise", async () => {
		const model = getModel("openai", "gpt-5")!;
		const run = (reasoningSummary?: "auto") => (onPayload: (r: unknown) => never) =>
			streamResponses(model, context, { apiKey: "sk-test", reasoningEffort: "high", reasoningSummary, onPayload });
		expect((await capture(run())).reasoning?.summary).toBe("detailed");
		expect((await capture(run("auto"))).reasoning?.summary).toBe("auto");
	});

	it("requests a detailed summary from Azure OpenAI Responses unless told otherwise", async () => {
		const model = getModel("azure-openai-responses", "gpt-5")!;
		const run = (reasoningSummary?: "concise") => (onPayload: (r: unknown) => never) =>
			streamAzure(model, context, {
				apiKey: "test",
				azureBaseUrl: "https://example.openai.azure.com",
				reasoningEffort: "high",
				reasoningSummary,
				onPayload,
			});
		expect((await capture(run())).reasoning?.summary).toBe("detailed");
		expect((await capture(run("concise"))).reasoning?.summary).toBe("concise");
	});
});
