import { describe, expect, it } from "vitest";
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";
import type { ModelCost } from "../src/types.ts";

const previous: ModelCost = { input: 7, output: 8, cacheRead: 9, cacheWrite: 11 };
const tokens = { input: 100000, output: 10000, cacheRead: 172000, cacheWrite: 0 };
const entry = (id: string, provider = "amazon-bedrock", type: "chat" | "classifier" = "chat") => ({
	provider,
	id,
	type,
	cost: previous,
});

// nredd/pi#57: AWS's model cards list exact profiles, not arbitrary prefix aliases.
describe("Nova Standard N. Virginia", () => {
	it.each([
		["amazon.nova-2-lite-v1:0", ["", "us.", "eu.", "jp.", "global."], 0.3, 0.075, 2.5],
		["amazon.nova-lite-v1:0", ["", "us.", "ca.", "eu.", "apac."], 0.06, 0.015, 0.24],
		["amazon.nova-micro-v1:0", ["", "us.", "eu."], 0.035, 0.00875, 0.14],
		["amazon.nova-pro-v1:0", ["", "us.", "eu.", "apac."], 0.8, 0.2, 3.2],
	] as const)("assesses %s and only documented profiles", (id, prefixes, input, read, output) => {
		for (const prefix of prefixes) {
			const cost = catalogueCost(entry(prefix + id));
			expect(cost).toMatchObject({
				input,
				output,
				cacheRead: read,
				cacheWrite: 11,
				assessment: { status: "verified", unavailable: ["cacheWrite"] },
			});
			expect(estimateTokenCost({ cost }, tokens).cost?.total).toBeCloseTo(
				(100000 * input + 172000 * read + 10000 * output) / 1e6,
			);
			expect(estimateTokenCost({ cost }, { ...tokens, cacheWrite: 1, shortCacheWrites: true }).cost).toBeNull();
		}
	});
	it("does not invent profiles, cross-provider identity, or cache hits", () => {
		for (const id of [
			"apac.amazon.nova-micro-v1:0",
			"global.amazon.nova-lite-v1:0",
			"global.amazon.nova-micro-v1:0",
			"global.amazon.nova-pro-v1:0",
		])
			expect(catalogueCost(entry(id)).assessment?.status).toBe("unknown");
		expect(catalogueCost(entry("amazon.nova-lite-v1:0", "other")).assessment?.status).toBe("unknown");
		expect(catalogueCost(entry("amazon.nova-lite-v1:0", "amazon-bedrock", "classifier")).assessment?.status).toBe(
			"unknown",
		);
		const cost = catalogueCost(entry("amazon.nova-lite-v1:0"));
		expect(estimateTokenCost({ cost }, { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }).cost?.total).toBe(
			0.06,
		);
	});
});

// nredd/pi#58: the tier boundary uses all input and prices the whole request.
describe("Bedrock OpenAI Global CRIS", () => {
	it.each([
		["openai.gpt-6-astra", 10, 1, 50, 12.5],
		["openai.gpt-6.1-sol", 2, 0.1, 10, 2.5],
		["openai.gpt-6.1-terra", 1, 0.05, 5, 1.25],
	] as const)("prices %s with strict boundary and exact profiles", (id, input, read, output, write) => {
		for (const prefix of ["", "us.", "global."]) {
			const cost = catalogueCost(entry(prefix + id));
			expect(cost).toMatchObject({
				input,
				cacheRead: read,
				output,
				cacheWrite: write,
				assessment: { status: "verified", unavailable: [] },
			});
			for (const extra of [0, 1]) {
				const count = { ...tokens, input: tokens.input + extra };
				const expected =
					((100000 + extra) * input * (extra ? 2 : 1) +
						172000 * read * (extra ? 2 : 1) +
						10000 * output * (extra ? 1.5 : 1)) /
					1e6;
				expect(estimateTokenCost({ cost }, count).cost?.total).toBeCloseTo(expected);
			}
			// 30m is the only explicit TTL: priced when the caller states short writes, never inferred.
			for (const extra of [{}, { cacheWrite1h: 1 }, { cacheWrite12h: 1 }])
				expect(estimateTokenCost({ cost }, { ...tokens, cacheWrite: 1, ...extra }).cost).toBeNull();
			// Writes count toward the request-wide boundary: exactly 272000 total is Standard, one more crosses.
			for (const extra of [0, 1]) {
				const count = { ...tokens, input: tokens.input - 1000 + extra, cacheWrite: 1000, shortCacheWrites: true };
				const tier = extra ? 2 : 1;
				const expected =
					((100000 - 1000 + extra) * input * tier +
						172000 * read * tier +
						10000 * output * (extra ? 1.5 : 1) +
						1000 * write * tier) /
					1e6;
				expect(estimateTokenCost({ cost }, count).cost?.total).toBeCloseTo(expected, 9);
			}
		}
		expect(catalogueCost(entry(`eu.${id}`)).assessment?.status).toBe("unknown");
	});
	it("updates older assessments but retains newer assessed catalogue prices", () => {
		for (const id of ["amazon.nova-lite-v1:0", "global.openai.gpt-6.1-terra"]) {
			const base = catalogueCost(entry(id));
			if (!base.assessment || base.assessment.status === "unknown") throw new Error("Missing assessment");
			const older = { ...base, input: 99, assessment: { ...base.assessment, checkedAt: "2026-11-12" } };
			const newer = { ...base, input: 99, assessment: { ...base.assessment, checkedAt: "2026-11-14" } };
			expect(catalogueCost({ ...entry(id), cost: older })).toMatchObject({
				input: base.input,
				assessment: { checkedAt: "2026-11-13" },
			});
			expect(catalogueCost({ ...entry(id), cost: newer })).toBe(newer);
		}
	});
	it("does not mutate old recorded cost or counters", () => {
		const original = structuredClone(previous);
		const counts = structuredClone(tokens);
		estimateTokenCost({ cost: catalogueCost(entry("openai.gpt-6-astra")) }, counts);
		expect(previous).toEqual(original);
		expect(counts).toEqual(tokens);
	});
});
