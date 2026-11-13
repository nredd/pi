import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	calculateTokenCost,
	catalogueCost,
	costRates,
	estimateTokenCost,
	OPENAI_STANDARD_COSTS,
} from "../src/catalog-pricing.ts";
import { ModelCostSchema } from "../src/providers/model-schema.ts";
import type { ModelCost, ModelType, Usage } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const free = {
	...zero,
	assessment: {
		status: "free",
		source: "https://example.test/pricing",
		checkedAt: "2026-11-12",
		unit: "usd-per-million-tokens",
		conditions: "Synthetic verified free token service.",
	},
} satisfies ModelCost;
function entry(provider = "example-provider", id = "example-model", type?: ModelType, cost: ModelCost = zero) {
	return { provider, id, type, cost };
}
function usage(): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 1_000_000,
		totalTokens: 4_000_000,
		cost: { ...zero, total: 0 },
	};
}
const sol = catalogueCost(entry("openai", "gpt-6.1-sol"));

// nredd/pi#46: an unverified zero must never acquire verified-free semantics.
describe("catalogue assessment", () => {
	it("runs in the requested native test runtime", () => {
		if (process.env.PRICING_TEST_RUNTIME)
			expect(process.versions.bun ? "bun" : "node").toBe(process.env.PRICING_TEST_RUNTIME);
	});
	it("keeps unknown, free and verified distinct, including numeric zero", () => {
		expect(catalogueCost(entry()).assessment?.status).toBe("unknown");
		const missing = JSON.parse(JSON.stringify(entry()));
		delete missing.cost;
		expect(catalogueCost(missing)).toMatchObject({ input: 0, assessment: { status: "unknown" } });
		expect(catalogueCost(entry("example-provider", "free", "classifier", free))).toEqual(free);
		expect(catalogueCost(entry("example-provider", "paid", "chat", { ...zero, input: 100 })).assessment?.status).toBe(
			"unknown",
		);
		expect(catalogueCost(entry("amazon-bedrock")).assessment).toMatchObject({
			status: "unknown",
			reason: expect.stringContaining("mapping"),
		});
		expect(catalogueCost(entry("example-provider", "image", "image")).assessment).toMatchObject({
			status: "unknown",
			reason: expect.stringContaining("Non-token"),
		});
	});
	it("does not infer pricing from an unmapped name or similar alias", () => {
		for (const model of [
			entry("example-provider", "gpt-6.1-sol"),
			entry("openai", "gpt-6.1-sol-alias"),
			entry("openai", "gpt-6.1-sol", "classifier"),
			entry("anthropic", "claude-sonnet-5-5-alias"),
		])
			expect(catalogueCost(model).assessment?.status).toBe("unknown");
	});
	it("shares the generator's exact Codex API-equivalent mapping", () => {
		for (const id of [
			"gpt-5.5",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-6-astra",
			"gpt-6-sol",
			"gpt-6-luna",
			"gpt-6.1-sol",
		]) {
			expect(catalogueCost(entry("openai-codex", id))).toEqual(catalogueCost(entry("openai", id)));
		}
		for (const id of Object.keys(OPENAI_STANDARD_COSTS))
			expect(catalogueCost(entry("openai", id)).assessment?.status).toBe("verified");
		expect(catalogueCost(entry("openai-codex", "gpt-4.1")).assessment?.status).toBe("unknown");
		expect(catalogueCost(entry("openai", "gpt-4.1")).tiers).toBeUndefined();
		for (const provider of ["openai", "anthropic"])
			expect(catalogueCost(entry(provider, "constructor")).assessment?.status).toBe("unknown");
		expect(sol.assessment).toMatchObject({
			status: "verified",
			checkedAt: "2026-11-12",
			unit: "usd-per-million-tokens",
		});
		expect(sol).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite12h: 5 });
	});
	it("does not replace newer explicitly assessed prices", () => {
		const cost: ModelCost = {
			...sol,
			input: 7,
			assessment: { ...free.assessment!, checkedAt: "2026-11-13", status: "verified" },
		};
		expect(catalogueCost(entry("openai", "gpt-6.1-sol", "chat", cost))).toBe(cost);
	});
	it.each(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"])(
		"assesses direct %s without leaking rates to partners",
		(id) => {
			expect(catalogueCost(entry("anthropic", id)).assessment?.status).toBe("verified");
			expect(catalogueCost(entry("amazon-bedrock", id)).assessment?.status).toBe("unknown");
		},
	);
	it("uses the published Bedrock baseline without claiming actual profile invoices", () => {
		for (const prefix of ["", "global.", "us.", "eu.", "au.", "jp.", "in.", "ca.", "apac."]) {
			const cost = catalogueCost(entry("amazon-bedrock", `${prefix}anthropic.claude-sonnet-5-5`));
			expect(cost).toMatchObject({
				input: 2,
				output: 10,
				cacheRead: 0.1,
				cacheWrite: 2.5,
				cacheWrite1h: 4,
				assessment: {
					status: "verified",
					source: "https://aws.amazon.com/bedrock/pricing/",
					conditions: expect.stringContaining("NOT actual regional/profile invoice"),
				},
			});
			expect(cost.tiers).toBeUndefined();
		}
		for (const id of [
			"example.anthropic.claude-sonnet-5-5",
			"anthropic.claude-sonnet-5-5-alias",
			"anthropic.claude-sonnet-4-5-20250929-v1:0",
			"constructor",
		])
			expect(catalogueCost(entry("amazon-bedrock", id)).assessment?.status).toBe("unknown");
		expect(catalogueCost(entry("example-provider", "global.anthropic.claude-sonnet-5-5")).assessment?.status).toBe(
			"unknown",
		);
		const haiku = catalogueCost(entry("amazon-bedrock", "global.anthropic.claude-haiku-5-5"));
		expect(costRates(haiku, 100000).input).toBe(0.1);
		expect(costRates(haiku, 100001)).toMatchObject({
			input: 0.5,
			output: 2.5,
			cacheRead: 0.05,
			cacheWrite: 0.625,
			cacheWrite1h: 1,
		});
		expect(
			estimateTokenCost({ cost: haiku }, { ...zero, cacheWrite: 100001, cacheWrite1h: 100001 }).cost?.cacheWrite,
		).toBeCloseTo(0.100001);
	});
	it("keeps Gemini storage charges separate and does not assume Vertex parity", () => {
		expect(catalogueCost(entry("google", "gemini-2.5-pro")).assessment).toMatchObject({
			status: "verified",
			conditions: expect.stringContaining("storage"),
		});
		expect(catalogueCost(entry("google-vertex", "gemini-2.5-pro")).assessment?.status).toBe("unknown");
	});
	it("validates explicit lifetime prices and assessment schemas", () => {
		const schema = Compile(ModelCostSchema);
		for (const cost of [sol, free, catalogueCost(entry())]) expect(schema.Check(cost)).toBe(true);
		for (const assessment of [
			{ status: "verified" },
			{ ...free.assessment, unit: "per-image" },
			{ ...free.assessment, checkedAt: "yesterday" },
		])
			expect(schema.Check({ ...zero, assessment })).toBe(false);
		expect(schema.Check({ ...zero, cacheWrite1h: -1 })).toBe(false);
	});
});

// nredd/pi#46: all input participates in strict threshold selection, not only uncached input.
describe("request arithmetic", () => {
	it("uses the highest matching tier even when thresholds are not sorted", () => {
		const cost: ModelCost = {
			...zero,
			tiers: [
				{ ...zero, input: 9, inputTokensAbove: 200 },
				{ ...zero, input: 5, inputTokensAbove: 100 },
			],
		};
		expect(costRates(cost, 100).input).toBe(0);
		expect(costRates(cost, 101).input).toBe(5);
		expect(costRates(cost, 201).input).toBe(9);
	});
	it.each([
		["openai", "gpt-6.1-sol", 272000, 2, 4],
		["anthropic", "claude-haiku-5-5", 100000, 0.1, 0.5],
		["google", "gemini-2.5-pro", 200000, 1.25, 2.5],
	] as const)("prices %s at the boundary and boundary+1", (provider, id, boundary, low, high) => {
		const cost = catalogueCost(entry(provider, id));
		for (const extra of [0, 1]) {
			const value = {
				...usage(),
				input: provider === "google" ? 10 : 0,
				cacheRead: boundary - 10 + extra,
				cacheWrite: provider === "google" ? 0 : 10,
				output: 0,
			};
			const estimate = estimateTokenCost({ cost }, { ...value, shortCacheWrites: true });
			expect(estimate.cost).not.toBeNull();
			expect(costRates(cost, value.input + value.cacheRead + value.cacheWrite).input).toBe(extra ? high : low);
		}
	});
	it("converts one million tokens per category and does not mutate inputs", () => {
		const tokens = { ...usage(), cacheWrite: 0 };
		const before = structuredClone(tokens);
		const estimate = estimateTokenCost({ cost: sol }, tokens);
		expect(estimate.cost).toEqual({ input: 4, output: 15, cacheRead: 0.2, cacheWrite: 0, total: 19.2 });
		expect(tokens).toEqual(before);
	});
	it("prices mixed 5m/1h and 30m/12h writes explicitly", () => {
		const anthropic = catalogueCost(entry("anthropic", "claude-sonnet-5-5"));
		const tokens = { ...zero, cacheWrite: 1_000_000, cacheWrite1h: 400000, shortCacheWrites: true };
		expect(estimateTokenCost({ cost: anthropic }, tokens).cost?.cacheWrite).toBeCloseTo(3.1);
		expect(
			estimateTokenCost(
				{ cost: sol },
				{ ...zero, cacheWrite: 1_000_000, cacheWrite12h: 400000, shortCacheWrites: true },
			).cost?.cacheWrite,
		).toBeCloseTo(7);
		expect(
			estimateTokenCost({ cost: anthropic }, { ...zero, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }).cost
				?.cacheWrite,
		).toBe(4);
	});
	it("retains legacy request-time fallback but uses explicit one-hour prices", () => {
		expect(calculateTokenCost({ ...zero, input: 3 }, { ...usage(), cacheWrite1h: 1_000_000 }).cacheWrite).toBe(6);
		expect(
			calculateTokenCost({ ...zero, input: 3, cacheWrite1h: 7 }, { ...usage(), cacheWrite1h: 1_000_000 }).cacheWrite,
		).toBe(7);
	});
	it("accepts verified free usage", () => {
		expect(estimateTokenCost({ cost: free }, zero).cost?.total).toBe(0);
	});
	it("reports unavailable model, rates and unsupported units", () => {
		expect(estimateTokenCost(undefined, zero).reason).toContain("mapping");
		expect(estimateTokenCost({ cost: zero }, zero).reason).toContain("verified");
		expect(estimateTokenCost({ cost: catalogueCost(entry()) }, zero).reason).toContain("alias");
		expect(estimateTokenCost({ type: "image", cost: free }, zero).reason).toContain("unsupported");
	});
	it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid token counter %s", (input) => {
		expect(estimateTokenCost({ cost: sol }, { ...zero, input }).reason).toContain("counter");
	});
	it("refuses unknown, overflowing or unsupported cache lifetimes", () => {
		expect(
			estimateTokenCost({ cost: catalogueCost(entry("openai", "gpt-5.2-pro")) }, { ...zero, cacheRead: 1 }).reason,
		).toContain("category");
		expect(estimateTokenCost({ cost: sol }, { ...zero, cacheWrite: 1 }).reason).toContain("lifetime");
		expect(estimateTokenCost({ cost: sol }, { ...zero, cacheWrite1h: 1 }).reason).toContain("exceed");
		expect(estimateTokenCost({ cost: sol }, { ...zero, cacheWrite: 1, cacheWrite1h: 1 }).reason).toContain("price");
		expect(estimateTokenCost({ cost: free }, { ...zero, cacheWrite: 1, cacheWrite12h: 1 }).reason).toContain("price");
	});
	it.each([NaN, Infinity, -1])("rejects invalid rates %s", (input) => {
		expect(estimateTokenCost({ cost: { ...sol, input } }, zero).reason).toContain("Invalid");
	});
	it("fails closed on malformed remote assessments and tier metadata", () => {
		for (const patch of [
			{ status: "invalid" },
			{ unit: "per-image" },
			{ source: 0 },
			{ source: "" },
			{ conditions: 0 },
			{ conditions: "" },
			{ checkedAt: 0 },
			{ checkedAt: "yesterday" },
			{ unavailable: "input" },
			{ unavailable: ["bogus"] },
		]) {
			const cost = { ...sol, assessment: { ...sol.assessment, ...patch } } as unknown as ModelCost;
			expect(estimateTokenCost({ cost }, zero).cost).toBeNull();
		}
		for (const tiers of ["invalid", [null], [{ inputTokensAbove: 0.5 }], [{ inputTokensAbove: -1 }]])
			expect(estimateTokenCost({ cost: { ...sol, tiers } as unknown as ModelCost }, zero).cost).toBeNull();
		expect(estimateTokenCost({ cost: sol }, { ...zero, input: Number.MAX_SAFE_INTEGER, output: 1 }).reason).toContain(
			"counter",
		);
		expect(
			estimateTokenCost(
				{ cost: { ...free, input: 1, tiers: [{ ...zero, inputTokensAbove: 1 }] } },
				{ ...zero, input: 2 },
			).cost,
		).toBeNull();
	});
	it("rejects nonzero rates labelled free", () => {
		expect(estimateTokenCost({ cost: { ...free, input: 1 } }, zero).reason).toContain("inconsistent");
	});
});
