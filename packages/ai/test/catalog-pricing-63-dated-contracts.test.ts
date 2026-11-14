import { describe, expect, it } from "vitest";
import { catalogueCost, estimateTokenCost } from "../src/catalog-pricing.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const get = (id: string, provider = "google") => catalogueCost({ provider, id, type: "chat", cost: zero });
const million = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
const total = (id: string, asOf: string, tokens = million) =>
	estimateTokenCost({ cost: get(id) }, tokens, asOf).cost?.total;

// nredd/pi#63: Standard paid contracts from the Gemini pricing page fetched 2026-11-13.
describe("Gemini dated paid Standard contracts", () => {
	it.each([
		["gemini-4-argon", "2026-11-30", "2026-12-01", 12.1],
		["gemini-3.8-flash", "2026-12-31", "2027-01-01", 4.575],
		["gemini-3.6-flash", "2026-12-31", "2027-01-01", 4.575],
	] as const)("prices %s through %s and refuses the announced later price from %s", (id, last, first, expected) => {
		expect(get(id).assessment).toMatchObject({ status: "verified", checkedAt: "2026-11-13", retiredOn: first });
		expect(total(id, "2026-11-13")).toBeCloseTo(expected, 10);
		expect(total(id, last)).toBeCloseTo(expected, 10);
		const later = estimateTokenCost({ cost: get(id) }, million, first);
		expect(later.cost).toBeNull();
		expect(later.reason).toContain("retired");
		expect(total(id, "2028-01-01")).toBeUndefined();
	});

	it("never applies the future price early or as a fallback", () => {
		// 2026-12-01 Argon is 4/20/0.20 = 24.2 per the page; the estimate must not return it.
		expect(total("gemini-4-argon", "2026-12-01")).toBeUndefined();
		expect(total("gemini-3.8-flash", "2027-01-01")).toBeUndefined();
	});

	it("keeps Argon implicit caching, storage and free-tier distinctions explicit", () => {
		const cost = get("gemini-4-argon");
		expect(cost.assessment).toMatchObject({ status: "verified", unavailable: ["cacheWrite"] });
		const conditions = (cost.assessment as { conditions: string }).conditions;
		expect(conditions).toContain("Not offered on the free tier");
		expect(conditions).toContain("explicit caching and storage are unsupported");
		expect(
			estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }, "2026-11-13").cost,
		).toBeNull();
		expect(estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, cacheWrite1h: 1 }, "2026-11-13").cost).toBeNull();
		// An ID the page prices but this catalogue lacks stays unknown, even with zero rates.
		expect(
			catalogueCost({ provider: "google", id: "gemini-4-hydrogen", type: "chat", cost: zero }).assessment?.status,
		).toBe("unknown");
	});

	it("treats Flash cache storage as a separate meter, not a write price", () => {
		for (const id of ["gemini-3.8-flash", "gemini-3.6-flash"]) {
			const cost = get(id);
			const conditions = (cost.assessment as { conditions: string }).conditions;
			expect(conditions).toContain("$0.50 through 2026-12-31 and $1.00 after");
			expect(conditions).toContain("not a cache-write token price");
			expect(
				estimateTokenCost({ cost }, { ...zero, cacheWrite: 1, shortCacheWrites: true }, "2026-11-13").cost,
			).toBeNull();
		}
	});

	it("prices the gemini-2.5-flash alias at its target's rates on both sides of the 2026-12-01 reroute", () => {
		const target = get("gemini-3.5-flash-lite");
		const alias = get("gemini-2.5-flash");
		expect(alias).toMatchObject({ input: target.input, output: target.output, cacheRead: target.cacheRead });
		expect(alias.assessment).toMatchObject({ status: "verified", unavailable: ["cacheWrite"] });
		expect((alias.assessment as { retiredOn?: string }).retiredOn).toBeUndefined();
		for (const day of ["2026-11-30", "2026-12-01", "2027-06-01"]) {
			expect(total("gemini-2.5-flash", day)).toBeCloseTo(2.83, 10);
			expect(total("gemini-3.5-flash-lite", day)).toBeCloseTo(2.83, 10);
		}
		const conditions = (alias.assessment as { conditions: string }).conditions;
		expect(conditions).toContain("route to gemini-3.5-flash-lite");
		expect(conditions).toContain("Audio input ($1.00) and cached audio ($0.10)");
		expect(conditions).toContain("apply only before the reroute");
		expect(conditions).not.toMatch(/text, image, video and audio/);
	});

	it.each([
		["gemini-2.5-flash-lite", 0.51],
		["gemini-3.1-flash-lite", 1.775],
		["gemini-3-flash-preview", 3.55],
	] as const)("prices %s text, image and video tokens without audio", (id, expected) => {
		expect(total(id, "2026-11-13")).toBeCloseTo(expected, 10);
		expect(get(id).assessment).toMatchObject({ status: "verified", unavailable: ["cacheWrite"] });
		expect((get(id).assessment as { conditions: string }).conditions).toContain(
			"only text, image and video input is covered",
		);
		expect((get(id).assessment as { retiredOn?: string }).retiredOn).toBeUndefined();
	});

	it.each(["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"])(
		"switches %s whole-request rates strictly above 200000 prompt tokens",
		(id) => {
			const at = (prompt: number) =>
				total(id, "2026-11-13", { input: prompt - 100000, cacheRead: 100000, output: 10000, cacheWrite: 0 });
			expect(at(200000)).toBeCloseTo((100000 * 2 + 100000 * 0.2 + 10000 * 12) / 1_000_000, 10);
			expect(at(200001)).toBeCloseTo((100001 * 4 + 100000 * 0.4 + 10000 * 18) / 1_000_000, 10);
			expect((get(id).assessment as { conditions: string }).conditions).toContain("$4.50 per million token-hours");
		},
	);

	it("does not share mutable tier arrays between lookups", () => {
		const first = get("gemini-3.1-pro-preview");
		first.tiers?.splice(0);
		expect(get("gemini-3.1-pro-preview-customtools").tiers).toHaveLength(1);
	});

	it("leaves unlisted, case-variant, other-provider and non-chat IDs unassessed", () => {
		for (const [provider, id] of [
			["google", "gemini-4-carbon"],
			["google", "gemini-4-hydrogen"],
			["google", "gemini-3.7-flash"],
			["google", "gemini-3.5-flash"],
			["google", "gemini-flash-latest"],
			["google", "gemini-flash-lite-latest"],
			["google", "gemini-3.1-flash-lite-preview"],
			["google", "gemini-3.1-flash-lite-image"],
			["google", "gemini-3.1-flash-live-preview"],
			["google", "gemini-2.5-computer-use-preview-10-2025"],
			["google", "deep-research-preview-04-2026"],
			["google", "gemma-4-31b-it"],
			["google", "gemini-4-argon-preview"],
			["google", "Gemini-4-Argon"],
			["google-vertex", "gemini-4-argon"],
			["google-vertex", "gemini-2.5-flash"],
			["example", "gemini-3.8-flash"],
		]) {
			expect(get(id, provider).assessment?.status, `${provider}/${id}`).toBe("unknown");
		}
		expect(
			catalogueCost({ provider: "google", id: "gemini-4-argon", type: "image", cost: zero }).assessment?.status,
		).toBe("unknown");
	});

	it("refuses an evaluation before the fetch date", () => {
		const early = estimateTokenCost({ cost: get("gemini-4-argon") }, million, "2026-11-12");
		expect(early.cost).toBeNull();
		expect(early.reason).toContain("precedes");
	});
});
