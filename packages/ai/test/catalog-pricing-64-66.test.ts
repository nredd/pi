import { describe, expect, it } from "vitest";
import brokerPrices from "../src/broker-pricing-data.json" with { type: "json" };
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";
import type { ModelCost } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const entry = (provider: string, id: string, cost: ModelCost = zero) => ({ provider, id, cost });

// nredd/pi#64 and #66: exact public broker contracts are not account prices.
describe("broker pricing", () => {
	it("prices the strict Radius Haiku boundary and leaves writes unavailable", () => {
		const cost = catalogueCost(entry("radius", "claude-haiku-5-5"));
		expect(cost.assessment).toMatchObject({
			status: "verified",
			checkedAt: "2026-11-13",
			unavailable: ["cacheWrite"],
		});
		for (const [input, expected] of [
			[100000, 0.01001],
			[100001, 0.0500505],
		] as const) {
			const result = estimateTokenCost({ cost }, { ...zero, input, output: 20 });
			expect(result.cost?.total).toBeCloseTo(expected);
		}
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
	});
	it("prices exact OpenCode paygo rates without fabricating cache writes", () => {
		const cost = catalogueCost(entry("opencode", "claude-haiku-4-5", { ...zero, cacheWrite: 7 }));
		expect(cost).toMatchObject({
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheWrite: 7,
			assessment: { unavailable: ["cacheWrite"] },
		});
		expect(
			estimateTokenCost({ cost }, { ...zero, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }).cost
				?.total,
		).toBeCloseTo(6.1);
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite1h: 1 }).cost).toBeNull();
	});
	it("does not infer aliases, providers, operation types, or promotions", () => {
		for (const model of [
			entry("radius", "claude-haiku-5-5-latest"),
			entry("radius", "precise"),
			entry("opencode-go", "claude-haiku-4-5"),
			entry("opencode", "big-pickle"),
			entry("opencode", "gpt-5-codex"),
			{ ...entry("radius", "claude-haiku-5-5"), type: "classifier" as const },
		])
			expect(catalogueCost(model).assessment?.status).toBe("unknown");
	});
	it("validates Radius source flags and rates before admitting an assessment", () => {
		const rows = brokerPrices.radius as Record<string, { free: unknown; cost: Record<string, unknown> }>;
		const original = rows["claude-haiku-4-5"];
		try {
			for (const row of [
				{ free: "true", cost: zero },
				{ free: true, cost: { ...zero, input: 1 } },
				{ free: false, cost: { ...zero, input: Number.NaN } },
				{ free: false, cost: { input: 1, output: 1, cacheWrite: 0 } },
				{ free: false, cost: { ...zero, input: 1, tiers: [null] } },
				{ free: false, cost: { ...zero, input: 1, tiers: [{ ...zero, input: 1 }] } },
			]) {
				rows["claude-haiku-4-5"] = row;
				expect(catalogueCost(entry("radius", "claude-haiku-4-5")).assessment?.status).toBe("unknown");
			}
			rows["claude-haiku-4-5"] = { free: true, cost: zero };
			expect(catalogueCost(entry("radius", "claude-haiku-4-5")).assessment?.status).toBe("free");
		} finally {
			rows["claude-haiku-4-5"] = original;
		}
	});
	it("replaces older assessments but preserves newer assessments", () => {
		const cost = catalogueCost(entry("radius", "claude-haiku-5-5"));
		if (cost.assessment?.status !== "verified") throw new Error("Expected verified rates");
		const older: ModelCost = { ...cost, input: 9, assessment: { ...cost.assessment, checkedAt: "2026-11-12" } };
		const newer: ModelCost = { ...cost, input: 9, assessment: { ...cost.assessment, checkedAt: "2026-11-14" } };
		expect(catalogueCost(entry("radius", "claude-haiku-5-5", older)).input).toBe(0.1);
		expect(catalogueCost(entry("radius", "claude-haiku-5-5", newer))).toBe(newer);
	});
});
