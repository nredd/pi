import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { addUsage, addUsageState } from "../src/harness/usage.ts";

function usage(total: number, unpriced = false): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: {
			input: total,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
			...(unpriced ? { unpriced: true as const } : {}),
		},
	};
}

// nredd/pi#83
describe("durable usage ledger with unpriced entries", () => {
	it("adds nothing to cost but keeps the marker and a count", () => {
		const total = structuredClone(usage(1));
		addUsage(total, usage(0, true));
		addUsage(total, usage(0, true));
		addUsage(total, usage(2));
		expect(total.cost).toMatchObject({ total: 3, unpriced: true, unpricedCalls: 2 });
		expect(total.input).toBe(40);
	});

	// nredd/pi#98: the ledger keeps a priced count so a free priced model plus unpriced reads $0.000, not unknown.
	it("counts a free priced request and a zero-usage failure apart", () => {
		const zeroUsage: Usage = { ...usage(0), input: 0, output: 0, totalTokens: 0 };
		const freePriced = structuredClone(usage(0));
		addUsage(freePriced, usage(0, true));
		expect(freePriced.cost).toMatchObject({ unpriced: true, unpricedCalls: 1, pricedCalls: 1 });

		const failed = structuredClone(zeroUsage);
		addUsage(failed, usage(0, true));
		expect(failed.cost).toMatchObject({ unpriced: true, unpricedCalls: 1, pricedCalls: 0 });

		const mixed = structuredClone(usage(1));
		addUsage(mixed, usage(0, true));
		addUsage(mixed, usage(2));
		expect(mixed.cost).toMatchObject({ unpricedCalls: 1, pricedCalls: 2 });
	});

	it("stays unmarked while every entry is priced", () => {
		const total = structuredClone(usage(1));
		addUsage(total, usage(2));
		expect("unpriced" in total.cost).toBe(false);
	});

	it("sums unpriced counts across states", () => {
		const a = { models: { m: { ...usage(0, true), cost: { ...usage(0, true).cost, unpricedCalls: 3 } } }, tools: {} };
		const b = { models: { m: { ...usage(0, true), cost: { ...usage(0, true).cost, unpricedCalls: 2 } } }, tools: {} };
		const sum = { models: {}, tools: {} } as typeof a;
		addUsageState(sum, a);
		addUsageState(sum, b);
		expect(sum.models.m.cost).toMatchObject({ unpriced: true, unpricedCalls: 5 });
	});
});
