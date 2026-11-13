import { describe, expect, it } from "vitest";
import prices from "../src/catalog-feed-prices.json" with { type: "json" };
import {
	catalogueCost,
	estimateTokenCost,
	getAiGatewayCost,
	getAiGatewayEvaluationCost,
	openRouterCost,
} from "../src/catalog-pricing.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { personalizeOpenRouterCatalog } from "../src/providers/openrouter.ts";
import type { AnyModel, Model, ModelCost } from "../src/types.ts";

const AS_OF = "2026-11-13";
const legacy: ModelCost = { input: 11, output: 22, cacheRead: 0, cacheWrite: 0 };
const zero: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const raw: Record<string, Record<string, { pricing: Record<string, unknown> }>> = prices;

const gateway = (id: string, cost: ModelCost = legacy) =>
	catalogueCost({ provider: "vercel-ai-gateway", id, type: "chat", cost });

// nredd/pi#55 and #56: Gateway `-batch` IDs are async Batch API selectors. Synchronous requests do not
// accept them, so they are not a default/Standard synchronous token contract.
describe("AI Gateway -batch identities", () => {
	const batchKeys = Object.keys(raw["vercel-ai-gateway"]).filter((key) => key.endsWith("-batch"));

	it("ships `-batch` feed rows, so the exclusion is not vacuous", () => {
		expect(batchKeys.length).toBeGreaterThan(0);
	});

	it("keeps anthropic/claude-opus-4.5-batch unknown and does not price it", () => {
		const cost = gateway("anthropic/claude-opus-4.5-batch");
		expect(cost.assessment?.status).toBe("unknown");
		expect(cost.input).toBe(legacy.input);
		expect(estimateTokenCost({ cost }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, AS_OF).cost).toBeNull();
	});

	it("admits no `-batch` key as verified", () => {
		const admitted = batchKeys.filter((key) => gateway(key.slice("chat:".length)).assessment?.status === "verified");
		expect(admitted).toEqual([]);
	});

	it("keeps the synchronous base model verified at its Standard rates", () => {
		const cost = gateway("anthropic/claude-opus-4.5");
		expect(cost.assessment?.status).toBe("verified");
		expect([cost.input, cost.output]).toEqual([5, 25]);
	});

	it("keeps an unrelated exact Gateway identity verified", () => {
		const cost = gateway("alibaba/qwen-3-14b");
		expect(cost.assessment?.status).toBe("verified");
		expect([cost.input, cost.output]).toEqual([0.12, 0.24]);
	});

	it("keeps an unknown Gateway id's incoming rates and stays unknown", () => {
		const cost = gateway("synthetic/not-in-feed");
		expect(cost.assessment?.status).toBe("unknown");
		expect(cost.input).toBe(legacy.input);
	});
});

const RADIX = ["0x10", "0b10", "0o10"] as const;
const OR_KEY = "chat:anthropic/claude-haiku-5.5";
const GW_KEY = "chat:alibaba/qwen-3-14b";

function withPricing<T>(provider: string, key: string, change: Record<string, unknown>, run: () => T): T {
	const original = raw[provider][key];
	try {
		raw[provider][key] = { ...original, pricing: { ...original.pricing, ...change } };
		return run();
	} finally {
		raw[provider][key] = original;
	}
}
const assess = (provider: string, key: string) =>
	catalogueCost({ provider, id: key.slice("chat:".length), type: "chat", cost: zero });

// nredd/pi#55 and #56: `Number()` accepts radix literals, so "0x10" was read as 16 USD/M.
describe("rate parsing accepts only decimal and scientific notation", () => {
	it("observes feed mutations, so the feed assertions below are not vacuous", () => {
		// 2e-7 differs from the archived 1e-7.
		expect(withPricing("openrouter", OR_KEY, { prompt: "2e-7" }, () => assess("openrouter", OR_KEY).input)).toBe(0.2);
	});

	it.each(RADIX)("openRouterCost base %s falls back to 0", (value) => {
		expect(openRouterCost({ prompt: value, completion: "0.000001" }).input).toBe(0);
	});

	it.each(RADIX)("openRouterCost override %s keeps the tier's base rate", (value) => {
		const cost = openRouterCost({ prompt: "0.000001", overrides: [{ min_prompt_tokens: 1000, prompt: value }] });
		expect(cost.tiers?.[0].input).toBe(1);
	});

	it.each(RADIX)("getAiGatewayCost base %s falls back to 0", (value) => {
		expect(getAiGatewayCost({ input: value, output: "0.000001" }).input).toBe(0);
	});

	it.each(RADIX)("getAiGatewayCost bracket %s keeps the tier's base rate like OpenRouter", (value) => {
		const cost = getAiGatewayCost({ input: "0.000001", input_tiers: [{ min: 1000, cost: value }] });
		expect(cost.tiers?.[0].input).toBe(1);
	});

	it.each(["abc", "-1", ""])("getAiGatewayCost bracket %j keeps the tier's base rate", (value) => {
		const cost = getAiGatewayCost({ input: "0.000001", input_tiers: [{ min: 1000, cost: value }] });
		expect(cost.tiers?.[0].input).toBe(1);
	});

	it.each([
		["1abc", "-1"],
		["0x10", "Infinity"],
		["", "junk"],
	])("getAiGatewayEvaluationCost input %j output %j falls back to 0", (input, output) => {
		expect(getAiGatewayEvaluationCost({ input, output })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("getAiGatewayEvaluationCost converts valid rates per million and never invents cache rates", () => {
		expect(getAiGatewayEvaluationCost({ input: "1e-7", output: "0.000002" })).toEqual({
			input: 0.1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it.each(RADIX)("OpenRouter feed prompt %s is never certified", (value) => {
		expect(
			withPricing("openrouter", OR_KEY, { prompt: value }, () => assess("openrouter", OR_KEY).assessment?.status),
		).toBe("unknown");
	});

	it.each(RADIX)("AI Gateway feed input %s is never certified", (value) => {
		expect(
			withPricing(
				"vercel-ai-gateway",
				GW_KEY,
				{ input: value },
				() => assess("vercel-ai-gateway", GW_KEY).assessment?.status,
			),
		).toBe("unknown");
	});

	it.each(RADIX)("an OpenRouter feed override %s is never certified", (value) => {
		expect(
			withPricing(
				"openrouter",
				OR_KEY,
				{ overrides: [{ min_prompt_tokens: 1000, prompt: value }] },
				() => assess("openrouter", OR_KEY).assessment?.status,
			),
		).toBe("unknown");
	});

	it.each(RADIX)("an AI Gateway feed bracket %s is never certified", (value) => {
		expect(
			withPricing(
				"vercel-ai-gateway",
				GW_KEY,
				{ input_tiers: [{ min: 0, cost: value }] },
				() => assess("vercel-ai-gateway", GW_KEY).assessment?.status,
			),
		).toBe("unknown");
	});

	it.each([
		["1e-7", 0.1],
		["1E-7", 0.1],
		["0.0000001", 0.1],
		[" 0.0000001 ", 0.1],
		["0", 0],
	] as const)("still accepts %j", (value, expected) => {
		expect(openRouterCost({ prompt: value }).input).toBe(expected);
		expect(getAiGatewayCost({ input: value }).input).toBe(expected);
	});

	it("still accepts numeric rates", () => {
		expect(getAiGatewayCost({ input: 0.0000001 }).input).toBe(0.1);
	});

	it("keeps an official scientific-notation feed rate verified", () => {
		const cost = withPricing("openrouter", OR_KEY, { prompt: "1e-7" }, () => assess("openrouter", OR_KEY));
		expect(cost.assessment?.status).toBe("verified");
		expect(cost.input).toBe(0.1);
	});

	it.each(["-1", "", "junk", "Infinity", "NaN"])("malformed %j falls back to 0 and is never verified", (value) => {
		expect(openRouterCost({ prompt: value }).input).toBe(0);
		expect(getAiGatewayCost({ input: value }).input).toBe(0);
		expect(
			withPricing("openrouter", OR_KEY, { prompt: value }, () => assess("openrouter", OR_KEY).assessment?.status),
		).toBe("unknown");
	});

	it("treats missing input and output as unknown, not free", () => {
		const cost = withPricing("vercel-ai-gateway", GW_KEY, { input: undefined, output: undefined }, () =>
			assess("vercel-ai-gateway", GW_KEY),
		);
		expect(cost.assessment?.status).toBe("unknown");
	});
});

const FEED_ID = "anthropic/claude-haiku-5.5";
const chat = (id: string, cost: ModelCost): Model<"anthropic-messages"> => ({
	provider: "openrouter",
	id,
	name: id,
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 1000,
	reasoning: false,
	cost,
});

// nredd/pi#55 and #56: a price the provider reported for the caller's key is not a stale catalogue row.
describe("live OpenRouter key prices", () => {
	async function personalize(id: string): Promise<AnyModel> {
		const response = Response.json({
			data: [{ id, context_length: 1_000_000, pricing: { prompt: "0.000009", completion: "0.000045" } }],
		});
		const fetcher = async () => response;
		const original = globalThis.fetch;
		globalThis.fetch = fetcher as typeof fetch;
		try {
			const context = {
				credential: { type: "api_key", key: "synthetic-not-a-credential" },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async () => true,
			} as unknown as RefreshModelsContext;
			const [model] = await personalizeOpenRouterCatalog([chat(id, legacy)], context);
			return model;
		} finally {
			globalThis.fetch = original;
		}
	}

	it("tags the live price as provider-reported and unassessed", async () => {
		const model = await personalize(FEED_ID);
		expect(model.cost.input).toBe(9);
		expect(model.cost.assessment).toMatchObject({ status: "unknown", origin: "provider-live" });
	});

	it("is kept over the frozen feed and stays unknown", async () => {
		const live = (await personalize(FEED_ID)).cost;
		const cost = catalogueCost({ provider: "openrouter", id: FEED_ID, type: "chat", cost: live });
		expect(cost).toBe(live);
		expect(estimateTokenCost({ cost }, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, AS_OF).cost).toBeNull();
	});

	it("is kept for an id outside the feed", async () => {
		const live = (await personalize("synthetic/not-in-feed")).cost;
		expect(catalogueCost({ provider: "openrouter", id: "synthetic/not-in-feed", type: "chat", cost: live })).toBe(
			live,
		);
	});

	it("does not protect a static catalogue row, with or without an unknown assessment", () => {
		for (const cost of [
			legacy,
			{ ...legacy, assessment: { status: "unknown" as const, reason: "Official rates have not been verified." } },
		]) {
			const corrected = catalogueCost({ provider: "openrouter", id: FEED_ID, type: "chat", cost });
			expect(corrected.input).toBe(0.1);
			expect(corrected.assessment?.status).toBe("verified");
		}
	});

	it("does not tag a model whose key list carries no pricing", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => Response.json({ data: [{ id: FEED_ID }] })) as typeof fetch;
		try {
			const [model] = await personalizeOpenRouterCatalog([chat(FEED_ID, legacy)], {
				credential: { type: "api_key", key: "synthetic-not-a-credential" },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async () => true,
			} as unknown as RefreshModelsContext);
			expect(model.cost).toBe(legacy);
		} finally {
			globalThis.fetch = original;
		}
	});
});

// A self-declared `origin` is not proof of a live price: only the OpenRouter personalization path sets it.
describe("provider-live origin is OpenRouter-only", () => {
	const claimed = (): ModelCost => ({
		...legacy,
		assessment: { status: "unknown", reason: "x", origin: "provider-live" },
	});

	it("still corrects a non-OpenRouter row that carries the mark", () => {
		const cost = catalogueCost({
			provider: "vercel-ai-gateway",
			id: "anthropic/claude-opus-4.5",
			type: "chat",
			cost: claimed(),
		});
		expect(cost.assessment?.status).toBe("verified");
		expect([cost.input, cost.output]).toEqual([5, 25]);
	});

	it("keeps an OpenRouter row that carries the mark", () => {
		const previous = claimed();
		expect(catalogueCost({ provider: "openrouter", id: "synthetic/not-in-feed", type: "chat", cost: previous })).toBe(
			previous,
		);
	});
});

// An off-feed id has no archived contract. A verified previous assessment is older than this client's audit
// (PRICING_CHECKED_AT, 2026-11-12) when checked on or before that date, so it is replaced by unknown. One
// checked later is newer and is kept as is, even though the 2026-11-13 feed archive lacks the id.
describe.each(["openrouter", "vercel-ai-gateway"] as const)("%s id outside the archived feed", (provider) => {
	const verifiedOn = (checkedAt: string): ModelCost => ({
		...legacy,
		assessment: {
			status: "verified",
			checkedAt,
			source: "synthetic",
			unit: "usd-per-million-tokens",
			conditions: "synthetic",
		},
	});
	const row = (checkedAt: string): Parameters<typeof catalogueCost>[0] => ({
		provider,
		id: "synthetic/not-in-feed",
		type: "chat",
		cost: verifiedOn(checkedAt),
	});

	it("turns a verified assessment checked on the client audit date into unknown", () => {
		const cost = catalogueCost(row("2026-11-12"));
		expect(cost.assessment?.status).toBe("unknown");
		expect(cost.assessment).toMatchObject({ reason: expect.stringContaining("No admitted exact archived") });
	});

	it("keeps a verified assessment checked after the client audit date unchanged", () => {
		const input = row("2026-11-13");
		expect(catalogueCost(input)).toBe(input.cost);
	});
});
