import { describe, expect, it } from "vitest";
import { catalogueCost, isPricingRetired } from "../src/catalog-pricing.ts";
import { calculateCost } from "../src/models.ts";
import type { AnyModel, ModelCost, Usage } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function usage(): Usage {
	return {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 1_000_000,
		totalTokens: 4_000_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(provider: string, id: string): AnyModel {
	return { provider, id, type: "chat", cost: catalogueCost({ provider, id, type: "chat", cost: zero }) } as AnyModel;
}

// nredd/pi#83: request-time cost must not bill rates past the contract's retiredOn.
describe("calculateCost respects retiredOn", () => {
	it.each([
		["anthropic", "claude-sonnet-4-5", "2026-11-30", 3 + 15 + 0.3 + 3.75],
		["google", "gemini-2.5-pro", "2026-12-01", 1.25 + 10 + 0.125 + 0],
	] as const)("%s/%s is priced before and zero from %s", (provider, id, retiredOn, total) => {
		const m = model(provider, id);
		expect(m.cost.assessment).toMatchObject({ retiredOn });
		const before = new Date(Date.parse(`${retiredOn}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
		expect(calculateCost(m, usage(), before).total).toBeGreaterThan(0);
		for (const asOf of [retiredOn, "2099-01-01"]) {
			const retired = calculateCost(m, usage(), asOf);
			expect(retired).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		}
		if (provider === "anthropic") expect(calculateCost(m, usage(), before).total).toBeCloseTo(total);
	});

	it("resets a previously populated cost object and returns it", () => {
		const m = model("anthropic", "claude-sonnet-4-5");
		const u = usage();
		u.cost.total = 99;
		expect(calculateCost(m, u, "2026-11-30")).toBe(u.cost);
		expect(u.cost.total).toBe(0);
	});

	it("keeps legacy arithmetic without a bound or with a malformed one", () => {
		const base = model("anthropic", "claude-sonnet-4-5");
		const unbounded = model("anthropic", "claude-opus-4-5");
		expect(isPricingRetired(unbounded.cost, "2099-01-01")).toBe(false);
		expect(calculateCost(unbounded, usage(), "2099-01-01").total).toBeGreaterThan(0);
		const malformed = {
			...base,
			cost: { ...base.cost, assessment: { ...base.cost.assessment, retiredOn: "2026-02-30" } },
		} as AnyModel;
		expect(isPricingRetired(malformed.cost as ModelCost, "2099-01-01")).toBe(false);
		expect(calculateCost(malformed, usage(), "2099-01-01").total).toBeGreaterThan(0);
	});
});
