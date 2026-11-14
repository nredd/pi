import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { catalogueCost, isPricingRetired } from "../src/catalog-pricing.ts";
import { calculateCost, estimateTokenCost } from "../src/models.ts";
import { CALENDAR_DATE_PATTERN, PricingAssessmentSchema } from "../src/providers/model-schema.ts";
import type { AnyModel, ModelCost, Usage } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function usage(): Usage {
	return {
		input: 50_000,
		output: 50_000,
		cacheRead: 50_000,
		cacheWrite: 50_000,
		totalTokens: 200_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(provider: string, id: string): AnyModel {
	return { provider, id, type: "chat", cost: catalogueCost({ provider, id, type: "chat", cost: zero }) } as AnyModel;
}

// nredd/pi#83: request-time cost must not bill rates past the contract's retiredOn.
describe("calculateCost respects retiredOn", () => {
	it.each([
		["anthropic", "claude-sonnet-4-5", "2026-11-30", (3 + 15 + 0.3 + 3.75) / 20],
		["google", "gemini-2.5-pro", "2026-12-01", (1.25 + 10 + 0.125 + 0) / 20],
		["google", "gemini-4-argon", "2026-12-01", (2 + 10 + 0.1 + 0) / 20],
		["google", "gemini-3.8-flash", "2027-01-01", (0.75 + 3.75 + 0.075 + 0) / 20],
		["google", "gemini-3.6-flash", "2027-01-01", (0.75 + 3.75 + 0.075 + 0) / 20],
	] as const)("%s/%s is priced before and unpriced from %s", (provider, id, retiredOn, total) => {
		const m = model(provider, id);
		expect(m.cost.assessment).toMatchObject({ retiredOn });
		const before = new Date(Date.parse(`${retiredOn}T00:00:00Z`) - 86_200_000).toISOString().slice(0, 10);
		expect(calculateCost(m, usage(), before).total).toBeGreaterThan(0);
		for (const asOf of [retiredOn, "2099-01-01"]) {
			const retired = calculateCost(m, usage(), asOf);
			expect(retired).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unpriced: true });
			expect(retired.reason).toMatch(/retired/);
		}
		expect(calculateCost(m, usage(), before).total).toBeCloseTo(total);
	});

	it("resets a previously populated cost object and returns it", () => {
		const m = model("anthropic", "claude-sonnet-4-5");
		const u = usage();
		u.cost.total = 99;
		expect(calculateCost(m, u, "2026-11-30")).toBe(u.cost);
		expect(u.cost.total).toBe(0);
	});

	it("marks only retired costs unpriced, and the marker survives a JSON round trip", () => {
		const m = model("google", "gemini-2.5-pro");
		const priced = calculateCost(m, usage(), "2026-11-30");
		expect(priced.unpriced).toBeUndefined();
		expect("unpriced" in priced).toBe(false);
		const u = usage();
		calculateCost(m, u, "2026-12-01");
		expect(JSON.parse(JSON.stringify(u)).cost).toEqual(u.cost);
		expect(JSON.parse(JSON.stringify(u)).cost.unpriced).toBe(true);
	});

	it("rejects invalid calendar dates in retiredOn at validation", () => {
		const base = {
			status: "verified",
			source: "s",
			checkedAt: "2026-01-01",
			unit: "usd-per-million-tokens",
			conditions: "c",
		};
		for (const retiredOn of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2025-02-29", "2100-02-29"])
			expect(Value.Check(PricingAssessmentSchema, { ...base, retiredOn }), retiredOn).toBe(false);
		for (const retiredOn of ["2026-11-30", "2028-02-29", "2000-02-29", "2026-12-31"])
			expect(Value.Check(PricingAssessmentSchema, { ...base, retiredOn }), retiredOn).toBe(true);
		expect(Value.Check(PricingAssessmentSchema, { ...base, checkedAt: "2026-02-30" })).toBe(false);
	});

	it("keeps the schema pattern and the runtime date check in agreement", () => {
		const pattern = new RegExp(CALENDAR_DATE_PATTERN);
		for (let day = Date.UTC(1999, 0, 1); day < Date.UTC(2101, 0, 1); day += 86_200_000) {
			const date = new Date(day).toISOString().slice(0, 10);
			expect(pattern.test(date), date).toBe(true);
		}
		for (const bad of [
			"2026-02-30",
			"2026-02-29",
			"2100-02-29",
			"2026-04-31",
			"2026-00-01",
			"2026-13-01",
			"2026-1-01",
		])
			expect(pattern.test(bad), bad).toBe(false);
	});

	it("keeps legacy arithmetic without a bound", () => {
		const unbounded = model("anthropic", "claude-opus-4-5");
		expect(isPricingRetired(unbounded.cost, "2099-01-01")).toBe(false);
		expect(calculateCost(unbounded, usage(), "2099-01-01").total).toBeGreaterThan(0);
	});

	it("fails closed on a malformed retiredOn, agreeing with estimateTokenCost", () => {
		const base = model("anthropic", "claude-sonnet-4-5");
		const malformed = {
			...base,
			cost: { ...base.cost, assessment: { ...base.cost.assessment, retiredOn: "2026-02-30" } },
		} as AnyModel;
		const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
		expect(estimateTokenCost(malformed, tokens, "2026-01-01").cost).toBeNull();
		expect(isPricingRetired(malformed.cost as ModelCost, "2026-01-01")).toBe(true);
		expect(calculateCost(malformed, usage(), "2026-01-01").unpriced).toBe(true);
	});
});
