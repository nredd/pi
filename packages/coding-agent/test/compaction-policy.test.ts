import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction/compaction.ts";
import { resolveCompactionPolicy } from "../src/core/compaction/policy.ts";

// Refs nredd/pi-harness#751: capacity and working context are independent.
describe("compaction operating policy", () => {
	it.each([
		[1000000, 16384, undefined, 128000, 983616],
		[100000, 10000, undefined, 45000, 90000],
		[100001, 10000, undefined, 45000, 90001],
		[400000, 16384, 272000, 128000, 272000],
		[100000, 10000, 80000, 40000, 80000],
		[0, 16384, undefined, 128000, undefined],
		[0, 16384, 80000, 40000, 80000],
	] as const)("resolves window %s reserve %s ceiling %s", (window, reserve, ceiling, target, budget) => {
		expect(resolveCompactionPolicy(window, reserve, "auto", ceiling)).toEqual({
			inputBudget: budget,
			targetTokens: target,
			threshold: target,
			evidence: "application-fallback",
		});
	});
	it("clamps explicit targets to input capacity and preserves legacy mode", () => {
		expect(resolveCompactionPolicy(100000, 10000, 200000).threshold).toBe(90000);
		expect(resolveCompactionPolicy(100000, 10000, "contextWindow")).toMatchObject({
			threshold: 90000,
			evidence: "legacy",
		});
		expect(resolveCompactionPolicy(0, 10000, "contextWindow").inputBudget).toBeUndefined();
		expect(resolveCompactionPolicy(0, 10000, "contextWindow").threshold).toBe(Infinity);
	});
	it("uses strict greater-than semantics and honors disabled automatic compaction", () => {
		const settings = { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 };
		expect(shouldCompact(45000, 100000, settings)).toBe(false);
		expect(shouldCompact(45001, 100000, settings)).toBe(true);
		expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
	});
	it.each([
		[100, 100],
		[100, 101],
		[1, 0],
	])("rejects impossible budgets %s/%s", (window, reserve) => {
		expect(() => resolveCompactionPolicy(window, reserve)).toThrow(/No (input budget|positive compaction target)/);
	});
	it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid hard ceilings %s", (ceiling) => {
		expect(() => resolveCompactionPolicy(100000, 10000, "auto", ceiling)).toThrow("inputLimits.maxInputTokens");
	});
});
