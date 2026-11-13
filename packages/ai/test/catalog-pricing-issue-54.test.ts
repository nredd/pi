import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";
import { ModelCostSchema } from "../src/providers/model-schema.ts";
import type { ModelCost } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const entry = {
	provider: "openai",
	id: "gpt-5.3-codex",
	api: "openai-responses" as const,
	type: "chat" as const,
	cost: zero,
};
const cost = catalogueCost(entry);

// nredd/pi#54: the deprecated contract is not a blanket legacy assessment.
describe("GPT-5.3 Codex pricing", () => {
	it("assesses the exact Responses selector and preserves newer assessments", () => {
		expect(cost).toMatchObject({
			input: 1.75,
			output: 14,
			cacheRead: 0.175,
			cacheWrite: 0,
			assessment: {
				status: "verified",
				checkedAt: "2026-11-13",
				unavailable: ["cacheWrite"],
				maxInputTokens: 272000,
				maxContextTokens: 400000,
				maxOutputTokens: 128000,
				retiredOn: "2027-04-01",
			},
		});
		expect(Compile(ModelCostSchema).Check(cost)).toBe(true);
		const newer = { ...cost, input: 7, assessment: { ...cost.assessment, checkedAt: "2026-11-14" } } as ModelCost;
		expect(catalogueCost({ ...entry, cost: newer })).toBe(newer);
		for (const patch of [
			{ provider: "example" },
			{ provider: "openai-codex" },
			{ id: "gpt-5.3-codex-spark" },
			{ id: "gpt-5.3-codex-latest" },
			{ type: "classifier" as const },
			{ api: "openai-completions" as const },
			{ api: undefined },
		])
			expect(catalogueCost({ ...entry, ...patch }).assessment?.status).toBe("unknown");
	});
	it("prices mixed counters and rejects unsupported writes and envelopes", () => {
		expect(
			estimateTokenCost({ cost }, { ...zero, input: 100000, cacheRead: 50000, output: 20000 }, "2026-11-13").cost
				?.total,
		).toBeCloseTo(0.46375);
		for (const patch of [
			{ cacheWrite: 1 },
			{ cacheWrite: 1, cacheWrite1h: 1 },
			{ cacheWrite: 1, cacheWrite12h: 1 },
			{ cacheWrite: 1, shortCacheWrites: true },
		])
			expect(estimateTokenCost({ cost }, { ...zero, ...patch }, "2026-11-13").cost).toBeNull();
		expect(
			estimateTokenCost({ cost }, { ...zero, input: 172000, cacheRead: 100000, output: 128000 }, "2026-11-13").cost,
		).not.toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, input: 172001, cacheRead: 100000 }, "2026-11-13").reason).toContain(
			"Input",
		);
		expect(estimateTokenCost({ cost }, { ...zero, output: 128001 }, "2026-11-13").reason).toContain("Output");
		expect(estimateTokenCost({ cost }, zero, "2027-03-31").cost).not.toBeNull();
		expect(estimateTokenCost({ cost }, zero, "2027-04-01").reason).toContain("retired");
		expect(estimateTokenCost({ cost }, zero, "2026-11-12").reason).toContain("precedes");
	});
});
