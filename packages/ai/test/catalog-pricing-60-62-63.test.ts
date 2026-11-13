import { describe, expect, it } from "vitest";
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";
import type { ModelCost } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const get = (provider: string, id: string) => catalogueCost({ provider, id, type: "chat", cost: zero });

// nredd/pi#60: cache hits are billed at the full shared input price.
describe("Cerebras shared prices", () => {
	it.each([
		["gpt-oss-120b", 0.35, 0.75],
		["qwen-3.8-27b", 0.99, 1.49],
	] as const)("prices %s", (id, input, output) => {
		const cost = get("cerebras", id);
		expect(cost).toMatchObject({
			input,
			output,
			cacheRead: input,
			assessment: { status: "verified", checkedAt: "2026-11-13", unavailable: ["cacheWrite"] },
		});
		expect(
			estimateTokenCost({ cost }, { input: 500000, cacheRead: 500000, output: 1000000, cacheWrite: 0 }).cost?.total,
		).toBeCloseTo(input + output);
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
	});
});

// nredd/pi#62: the inclusive 200K threshold covers cached and uncached prompt tokens.
describe("xAI Standard global prices", () => {
	it.each([
		["grok-4.7", 2, 0.5, 6],
		["grok-4.6", 2, 0.5, 6],
		["grok-4.5", 2, 0.3, 6],
		["grok-4.3", 1.25, 0.2, 2.5],
	] as const)("prices %s across the boundary", (id, input, read, output) => {
		const cost = get("xai", id);
		for (const total of [199999, 200000, 200001]) {
			const tokens = { input: total - 100000, cacheRead: 100000, output: 10000, cacheWrite: 0 };
			const before = structuredClone(tokens);
			const estimate = estimateTokenCost({ cost }, tokens);
			expect(estimate.cost?.total).toBeCloseTo(
				(((total - 100000) * input + 100000 * read + 10000 * output) * (total >= 200000 ? 2 : 1)) / 1000000,
				10,
			);
			expect(tokens).toEqual(before);
		}
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
	});
});

// nredd/pi#63: storage token-hours are not a token-write tariff.
it("prices only paid Standard Gemini token categories", () => {
	const cost = get("google", "gemini-3.5-flash-lite");
	expect(cost).toMatchObject({
		input: 0.3,
		output: 2.5,
		cacheRead: 0.03,
		assessment: { status: "verified", unavailable: ["cacheWrite"] },
	});
	expect(
		estimateTokenCost({ cost }, { input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 0 }).cost?.total,
	).toBeCloseTo(2.83);
	expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite1h: 1 }).cost).toBeNull();
	const conditions = (cost.assessment as { conditions: string }).conditions;
	expect(conditions).toContain("text input");
	expect(conditions).toContain("Audio input");
	expect(conditions).toContain("image and audio output");
	expect(conditions).not.toMatch(/text, image, video and audio/);
});

it("rejects fabricated aliases and other providers or operation types", () => {
	for (const [provider, id] of [
		["cerebras", "gpt-oss-120b-latest"],
		["xai", "grok-4.7-fast"],
		["google", "gemini-3.5-flash-lite-preview"],
		["google-vertex", "gemini-3.5-flash-lite"],
		["example", "grok-4.7"],
	]) {
		expect(get(provider, id).assessment?.status).toBe("unknown");
	}
	expect(catalogueCost({ provider: "xai", id: "grok-4.7", type: "image", cost: zero }).assessment?.status).toBe(
		"unknown",
	);
});

it("preserves a newer assessment and refuses invalid or falsely free metadata", () => {
	const cost = get("xai", "grok-4.7");
	const older = { ...cost, input: 9, assessment: { ...cost.assessment, checkedAt: "2026-11-12" } } as ModelCost;
	expect(catalogueCost({ provider: "xai", id: "grok-4.7", type: "chat", cost: older })).toMatchObject({
		input: 2,
		assessment: { checkedAt: "2026-11-13" },
	});
	const newer = { ...cost, input: 9, assessment: { ...cost.assessment, checkedAt: "2026-11-14" } } as ModelCost;
	expect(catalogueCost({ provider: "xai", id: "grok-4.7", type: "chat", cost: newer })).toBe(newer);
	expect(estimateTokenCost({ cost: { ...cost, input: NaN } }, zero).cost).toBeNull();
	const free = { ...cost, assessment: { ...cost.assessment, status: "free" } } as ModelCost;
	expect(estimateTokenCost({ cost: free }, zero).cost).toBeNull();
});
