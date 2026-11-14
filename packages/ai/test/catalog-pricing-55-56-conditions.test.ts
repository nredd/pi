import { describe, expect, it } from "vitest";
import prices from "../src/catalog-feed-prices.json" with { type: "json" };
import { catalogueCost, costRates, estimateTokenCost } from "../src/catalog-pricing.ts";
import type { ModelCost } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const entry = (provider: string, id: string, cost: ModelCost = zero) => ({ provider, id, cost, type: "chat" as const });
const raw: Record<string, Record<string, { pricing: Record<string, unknown> }>> = prices;
const reason = (provider: string, id: string): string | undefined => {
	const assessment = catalogueCost(entry(provider, id)).assessment;
	return assessment?.status === "unknown" ? assessment.reason : undefined;
};
const verified = (cost: ModelCost) => {
	const assessment = cost.assessment;
	if (assessment?.status !== "verified") throw new Error("expected a verified assessment");
	return assessment;
};
const mutate = (provider: string, key: string, change: Record<string, unknown>, run: () => void): void => {
	const original = raw[provider][key];
	raw[provider][key] = { ...original, pricing: { ...original.pricing, ...change } };
	try {
		run();
	} finally {
		raw[provider][key] = original;
	}
};

// nredd/pi#55/#56: unsupported conditions get a precise reason, never a flat or silently dropped rate.
describe("precise unsupported-condition reasons", () => {
	it("names UTC time windows and weekdays for OpenRouter", () => {
		const key = "chat:anthropic/claude-haiku-5.5";
		const id = "anthropic/claude-haiku-5.5";
		const base = raw.openrouter[key].pricing.overrides as object[];
		mutate("openrouter", key, { overrides: [...base, { utc_start: 100, utc_end: 1500, prompt: "0.0000002" }] }, () =>
			expect(reason("openrouter", id)).toMatch(/UTC time-window.*`utc_start`, `utc_end`/),
		);
		mutate("openrouter", key, { overrides: [...base, { utc_days: ["sat"], prompt: "0.0000002" }] }, () =>
			expect(reason("openrouter", id)).toMatch(/`utc_days`/),
		);
		// Live windowed rows are outside the archived inventory, so they are unknown as absent identities.
		expect(reason("openrouter", "minimax/minimax-m3.1-flash")).toMatch(/No admitted exact/);
	});
	it("names provider variation for Gateway", () => {
		expect(reason("vercel-ai-gateway", "deepseek/deepseek-v4-flash")).toMatch(
			/`varies_by_provider`.*varies by serving/,
		);
	});
	it("names peak pricing and non-token fields", () => {
		const key = "chat:alibaba/qwen-3-14b";
		mutate("vercel-ai-gateway", key, { peak_pricing: {} }, () =>
			expect(reason("vercel-ai-gateway", "alibaba/qwen-3-14b")).toMatch(/`peak_pricing`.*peak-time/),
		);
		mutate("vercel-ai-gateway", key, { request: "0.01" }, () =>
			expect(reason("vercel-ai-gateway", "alibaba/qwen-3-14b")).toMatch(/`request`.*non-token/),
		);
		mutate("openrouter", "chat:anthropic/claude-haiku-5.5", { image: "0.001", audio: "0.1" }, () =>
			expect(reason("openrouter", "anthropic/claude-haiku-5.5")).toMatch(/`image`, `audio`.*non-token/),
		);
	});
	it("keeps a negative router sentinel unknown", () => {
		mutate("openrouter", "chat:anthropic/claude-haiku-5.5", { prompt: "-1", completion: "-1" }, () =>
			expect(reason("openrouter", "anthropic/claude-haiku-5.5")).toMatch(/negative/),
		);
	});
});

describe("AI Gateway Anthropic default cache writes", () => {
	const id = "anthropic/claude-haiku-5.5";
	it("admits the documented 5m default write with exact bracket pricing", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", id));
		expect(cost.assessment).toMatchObject({ status: "verified" });
		expect(verified(cost).unavailable).not.toContain("cacheWrite");
		expect(costRates(cost, 100000).cacheWrite).toBe(0.125);
		expect(costRates(cost, 100001).cacheWrite).toBe(0.625);
		const tokens = { ...zero, cacheWrite: 1000, shortCacheWrites: true };
		expect(estimateTokenCost({ cost }, tokens).cost?.cacheWrite).toBeCloseTo(0.000125, 12);
		expect(estimateTokenCost({ cost }, { ...tokens, input: 100000 }).cost?.cacheWrite).toBeCloseTo(0.000625, 12);
	});
	it("never prices a 1h or 12h write, or one with unknown lifetime", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", id));
		expect(cost.cacheWrite1h).toBeUndefined();
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite1h: 1 }).cost).toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite12h: 1 }).cost).toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1 }).reason).toContain("lifetime");
	});
	it("labels published but unvalued dimensions on the row", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", id));
		expect(verified(cost).conditions).toMatch(/1h writes unavailable/);
		expect(verified(cost).conditions).toMatch(/Published but unvalued for this row: regional, web_search/);
	});
	it("keeps a write off the documented 1.25x ratio unavailable", () => {
		mutate(
			"vercel-ai-gateway",
			`chat:${id}`,
			{ input_cache_write: "0.0000002", input_cache_write_tiers: [{ cost: "0.0000002", min: 0 }] },
			() => {
				const cost = catalogueCost(entry("vercel-ai-gateway", id));
				expect(verified(cost).unavailable).toContain("cacheWrite");
			},
		);
	});
	it("does not extend the Anthropic default to other vendors", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", "openai/gpt-6.1-sol"));
		expect(verified(cost).unavailable).toContain("cacheWrite");
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
	});
});
