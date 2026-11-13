import { expect, it } from "vitest";
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";

// nredd/pi#53: exact contract membership carries the rates and guards together.
it.each([
	["claude-fable-5-2", 8, 40, 0.2, 10, 16, 1000000, 128000, undefined],
	["claude-haiku-4-5", 1, 5, 0.1, 1.25, 2, 200000, 64000, undefined],
	["claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25, 2, 200000, 64000, undefined],
	["claude-opus-4-5", 5, 25, 0.5, 6.25, 10, 200000, 64000, undefined],
	["claude-opus-4-5-20251101", 5, 25, 0.5, 6.25, 10, 200000, 64000, undefined],
	["claude-sonnet-4-5", 3, 15, 0.3, 3.75, 6, 200000, 64000, "2026-11-30"],
	["claude-sonnet-4-5-20250929", 3, 15, 0.3, 3.75, 6, 200000, 64000, "2026-11-30"],
] as const)(
	"keeps %s rates, freshness, envelope, and lifecycle",
	(id, input, output, read, write, hour, context, maxOutput, retiredOn) => {
		const previous = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const cost = catalogueCost({ provider: "anthropic", id, cost: previous });
		expect(structuredClone(cost)).toMatchObject({
			input,
			output,
			cacheRead: read,
			cacheWrite: write,
			cacheWrite1h: hour,
			assessment: { checkedAt: "2026-11-13", maxContextTokens: context, maxOutputTokens: maxOutput },
		});
		if (cost.assessment?.status !== "verified") throw new Error("Missing assessment");
		expect(cost.assessment.retiredOn).toBe(retiredOn);
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		expect(estimateTokenCost({ cost }, { ...zero, output: maxOutput + 1 }, "2026-11-13").reason).toContain("Output");
		expect(estimateTokenCost({ cost }, { ...zero, input: context + 1 }, "2026-11-13").reason).toContain("context");
		if (retiredOn) expect(estimateTokenCost({ cost }, zero, retiredOn).reason).toContain("retired");
		const newer = { ...cost, input: 99, assessment: { ...cost.assessment, checkedAt: "2026-11-14" } };
		expect(catalogueCost({ provider: "anthropic", id, cost: newer })).toBe(newer);
	},
);

it("does not attach bounded metadata to other exact legacy rates", () => {
	const cost = catalogueCost({
		provider: "anthropic",
		id: "claude-sonnet-5-5",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	expect(cost.assessment).toMatchObject({ status: "verified", checkedAt: "2026-11-12" });
	if (cost.assessment?.status !== "verified") throw new Error("Missing assessment");
	expect(cost.assessment.maxContextTokens).toBeUndefined();
});
