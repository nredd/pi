import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { getAiGatewayCost } from "../scripts/ai-gateway-pricing.ts";
import { buildOpenRouterCatalog } from "../scripts/openrouter-catalog.ts";
import prices from "../src/catalog-feed-prices.json" with { type: "json" };
import { calculateTokenCost, catalogueCost, costRates, estimateTokenCost } from "../src/catalog-pricing.ts";
import { ModelCostSchema } from "../src/providers/model-schema.ts";
import { openRouterCost } from "../src/providers/openrouter-api.ts";
import type { ModelCost, ModelType, Usage } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const entry = (provider: string, id: string, cost: ModelCost = zero, type: ModelType = "chat") => ({
	provider,
	id,
	cost,
	type,
});
const raw: Record<string, Record<string, { pricing: Record<string, unknown> }>> = prices;

// nredd/pi#55/#56: these are advertised token baselines, never routed invoices or subscriptions.
describe("exact feed token contracts", () => {
	it("checks every admitted raw identity without promoting unsupported operations", () => {
		const schema = Compile(ModelCostSchema);
		for (const [provider, models] of Object.entries(prices)) {
			for (const key of Object.keys(models)) {
				const type = key.startsWith("classifier:") ? "classifier" : "chat";
				const id = key.slice(key.indexOf(":") + 1);
				const cost = catalogueCost(entry(provider, id, zero, type));
				expect(schema.Check(cost), `${provider}/${id}`).toBe(true);
				if (cost.assessment?.status === "verified") {
					expect(cost.assessment.checkedAt).toBe("2026-11-13");
					expect(cost.assessment.conditions).toContain("baseline only");
					expect(estimateTokenCost({ cost }, { ...zero, input: 1, output: 1 }).cost).not.toBeNull();
				}
				const otherType = type === "classifier" ? "chat" : "classifier";
				if (!Object.hasOwn(models, `${otherType}:${id}`))
					expect(catalogueCost(entry(provider, id, zero, otherType)).assessment?.status).toBe("unknown");
				expect(catalogueCost(entry(provider, id, zero, "image")).assessment?.status).toBe("unknown");
			}
		}
	});
	it("does not infer missing aliases, providers, free variants or legacy zero presence", () => {
		for (const model of [
			entry("openrouter", "missing/current-id"),
			entry("openrouter", "anthropic/claude-haiku-5.5:batch"),
			entry("openrouter", "anthropic/claude-haiku-5.5:free"),
			entry("vercel-ai-gateway", "missing/current-id"),
			entry("example-provider", "alibaba/qwen-3-14b"),
			entry("openrouter", "constructor"),
		])
			expect(estimateTokenCost({ cost: catalogueCost(model) }, zero).cost).toBeNull();
	});
	it("keeps missing Gateway categories unavailable rather than certified zero/free", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", "alibaba/qwen-3-14b"));
		expect(cost).toMatchObject({
			input: 0.12,
			output: 0.24,
			assessment: { status: "verified", unavailable: ["cacheRead", "cacheWrite"] },
		});
		expect(estimateTokenCost({ cost }, { ...zero, input: 1000, output: 1000 }).cost?.total).toBeCloseTo(0.00036);
		for (const tokens of [
			{ ...zero, cacheRead: 1 },
			{ ...zero, cacheWrite: 1, shortCacheWrites: true },
		])
			expect(estimateTokenCost({ cost }, tokens).reason).toContain("category");
	});
	it.each([
		["openrouter", "anthropic/claude-haiku-5.5", 100000, 0.1, 0.5],
		["openrouter", "anthropic/claude-sonnet-4.5", 200000, 3, 6],
		["vercel-ai-gateway", "openai/gpt-6.1-sol", 272000, 2, 4],
		["vercel-ai-gateway", "anthropic/claude-haiku-5.5", 100000, 0.1, 0.5],
	] as const)("prices whole %s/%s requests at the exact boundary", (provider, id, threshold, low, high) => {
		const cost = catalogueCost(entry(provider, id));
		for (const extra of [0, 1]) {
			const tokens = { ...zero, input: 1, cacheRead: threshold - 1 + extra, output: 10 };
			expect(costRates(cost, threshold + extra).input).toBe(extra ? high : low);
			const estimate = estimateTokenCost({ cost }, tokens);
			expect(estimate.cost?.input).toBeCloseTo((extra ? high : low) / 1_000_000, 12);
			expect(estimate.cost?.cacheRead).toBeCloseTo(
				(costRates(cost, threshold + extra).cacheRead * tokens.cacheRead) / 1_000_000,
				12,
			);
		}
	});
	it("preserves separate default/1h writes and rejects Gateway unknown TTLs", () => {
		const cost = catalogueCost(entry("openrouter", "anthropic/claude-haiku-5.5"));
		const tokens = { ...zero, input: 99900, cacheWrite: 101, cacheWrite1h: 50, shortCacheWrites: true };
		expect(estimateTokenCost({ cost }, tokens).cost?.cacheWrite).toBeCloseTo((51 * 0.625 + 50) / 1_000_000, 12);
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1 }).reason).toContain("lifetime");
		const gateway = catalogueCost(entry("vercel-ai-gateway", "openai/gpt-6.1-sol"));
		expect(gateway.cacheWrite).toBe(2.5); // Compatibility numeric data, not an established lifetime.
		expect(estimateTokenCost({ cost: gateway }, { ...zero, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite12h: 1 }).cost).toBeNull();
	});
	it("uses source order per key even for duplicate and unsorted OpenRouter thresholds", () => {
		const cost = openRouterCost({
			prompt: "0.000001",
			completion: "0.000002",
			input_cache_write_1h: "0.000006",
			overrides: [
				{ min_prompt_tokens: 200000, prompt: "0.000004", input_cache_write_1h: "0.000008" },
				{ min_prompt_tokens: 100000, completion: "0.000005" },
				{ min_prompt_tokens: 100000, prompt: "0.000003" },
			],
		});
		expect(costRates(cost, 200001)).toMatchObject({ input: 3, output: 5, cacheWrite1h: 8 });
		expect(costRates(cost, 100001)).toMatchObject({ input: 3, output: 5, cacheWrite1h: 6 });
	});
	it("reuses catalogue normalization and source snake_case Gateway brackets", () => {
		const source = prices.openrouter["chat:anthropic/claude-haiku-5.5"].pricing;
		const catalog = buildOpenRouterCatalog(
			[{ id: "anthropic/claude-haiku-5.5", name: "Public Haiku", supported_parameters: ["tools"], pricing: source }],
			[],
			[],
		);
		expect(catalog.chat[0].cost).toEqual(openRouterCost(source));
		expect(
			getAiGatewayCost(prices["vercel-ai-gateway"]["chat:openai/gpt-6.1-sol"].pricing).tiers?.[0].inputTokensAbove,
		).toBe(272000);
		const sparse = catalogueCost(entry("vercel-ai-gateway", "spacexai/grok-4.20-non-reasoning-beta"));
		expect(costRates(sparse, 200000).cacheRead).toBe(0.2);
		expect(costRates(sparse, 200001).cacheRead).toBe(0.4);
	});
	it("keeps temporal, provider-varying and non-token contracts unknown", () => {
		for (const [provider, id] of [
			["openrouter", "minimax/minimax-m3.1-flash"],
			["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
			["vercel-ai-gateway", "deepseek/deepseek-v4-flash"],
		] as const)
			expect(catalogueCost(entry(provider, id)).assessment?.status).toBe("unknown");
	});
	it("admits exact classifier token contracts without promoting their chat namesakes", () => {
		for (const [provider, id, inputRate] of [
			["openrouter", "cloudflare/clef", 0.192],
			["openrouter", "cloudflare/clef-flash", 0.019],
			["vercel-ai-gateway", "convaiinnovations/laya", 0.0105],
		] as const) {
			const cost = catalogueCost(entry(provider, id, zero, "classifier"));
			expect(cost.assessment).toMatchObject({ status: "verified", unavailable: ["cacheRead", "cacheWrite"] });
			expect(estimateTokenCost({ type: "classifier", cost }, { ...zero, input: 1000 }).cost?.total).toBeCloseTo(
				inputRate / 1000,
				12,
			);
			expect(estimateTokenCost({ type: "classifier", cost }, { ...zero, cacheRead: 1 }).cost).toBeNull();
			expect(catalogueCost(entry(provider, id)).assessment?.status).toBe("unknown");
		}
	});
	it("does not relabel exact Gateway Fast selectors as Standard", () => {
		for (const id of ["openai/gpt-4.1-fast", "anthropic/claude-opus-5.5-fast", "deepseek/deepseek-v4.1-flash-fast"])
			expect(catalogueCost(entry("vercel-ai-gateway", id)).assessment?.status).toBe("unknown");
	});
	it("honors OpenRouter top-provider context rather than its larger outer envelope", () => {
		const cost = catalogueCost(entry("openrouter", "z-ai/glm-5"));
		expect(cost.assessment).toMatchObject({ maxContextTokens: 202752 });
		expect(estimateTokenCost({ cost }, { ...zero, input: 202752 }, "2026-11-13").cost).not.toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, input: 203000 }, "2026-11-13").reason).toContain("context");
	});
	it("uses the merged estimator's source context, output and evaluation-date guards", () => {
		const cost = catalogueCost(entry("vercel-ai-gateway", "alibaba/qwen-3-14b"));
		expect(cost.assessment).toMatchObject({ maxContextTokens: 40960, maxOutputTokens: 16384 });
		expect(estimateTokenCost({ cost }, { ...zero, input: 40960 }, "2026-11-13").cost).not.toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, input: 40961 }, "2026-11-13").reason).toContain("context");
		expect(estimateTokenCost({ cost }, { ...zero, output: 16385 }, "2026-11-13").reason).toContain("Output");
		expect(estimateTokenCost({ cost }, zero, "2026-11-12").reason).toContain("precedes");
	});
	it("rejects malformed raw rates, missing categories and unsupported conditions before normalization", () => {
		const models = raw["vercel-ai-gateway"];
		const original = models["chat:alibaba/qwen-3-14b"];
		try {
			for (const change of [
				{ input: "-1" },
				{ input: "0.12junk" },
				{ input: "Infinity" },
				{ input: "" },
				{ peak_pricing: {} },
				{ varies_by_provider: true },
				{ request: "0.01" },
				{ input_tiers: [{ min: 0, max: 10, cost: "0.00000012" }] },
			]) {
				models["chat:alibaba/qwen-3-14b"] = { ...original, pricing: { ...original.pricing, ...change } };
				expect(catalogueCost(entry("vercel-ai-gateway", "alibaba/qwen-3-14b")).assessment?.status).toBe("unknown");
			}
			models["chat:alibaba/qwen-3-14b"] = { ...original, pricing: { input: "0", output: "0" } };
			const freeCategories = catalogueCost(entry("vercel-ai-gateway", "alibaba/qwen-3-14b"));
			expect(estimateTokenCost({ cost: freeCategories }, { ...zero, input: 1 }).cost?.total).toBe(0);
			expect(estimateTokenCost({ cost: freeCategories }, { ...zero, cacheRead: 1 }).cost).toBeNull();
		} finally {
			models["chat:alibaba/qwen-3-14b"] = original;
		}
	});
	it("keeps malformed OpenRouter override containers unknown rather than throwing or certifying zeros", () => {
		const models = raw.openrouter;
		const key = "chat:anthropic/claude-haiku-5.5";
		const original = models[key];
		try {
			for (const overrides of [{}, [null], [{ min_prompt_tokens: 100000, prompt: "-1" }]]) {
				models[key] = { ...original, pricing: { ...original.pricing, overrides } };
				expect(catalogueCost(entry("openrouter", "anthropic/claude-haiku-5.5")).assessment?.status).toBe("unknown");
			}
		} finally {
			models[key] = original;
		}
	});
	it("corrects dated12 source costs, preserves future14 assessments and recorded arithmetic", () => {
		const provider = "vercel-ai-gateway";
		const id = "alibaba/qwen-3-14b";
		const assessed = catalogueCost(entry(provider, id));
		const assessment = assessed.assessment;
		if (!assessment || assessment.status === "unknown") throw new Error("Expected an admitted source contract");
		for (const date of ["2026-11-12", "2026-11-14"]) {
			const previous: ModelCost = {
				...assessed,
				input: 9,
				assessment: { ...assessment, checkedAt: date },
			};
			expect(catalogueCost(entry(provider, id, previous)).input).toBe(date.endsWith("14") ? 9 : 0.12);
		}
		const recorded: Usage = { ...zero, input: 1000, totalTokens: 1000, cost: { ...zero, total: 99 } };
		const before = structuredClone(recorded);
		expect(estimateTokenCost({ cost: assessed }, recorded).cost?.total).toBeCloseTo(0.00012);
		expect(recorded).toEqual(before);
		const request = structuredClone(recorded);
		expect(calculateTokenCost(assessed, request).total).toBeCloseTo(0.00012);
	});
});
