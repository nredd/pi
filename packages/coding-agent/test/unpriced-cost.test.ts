import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import type { AnyModel } from "@earendil-works/pi-ai";
import { type AssistantMessage, calculateCost, catalogueCost, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { formatCacheWarmingUsage } from "../src/core/cache-warmer.ts";
import { SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import {
	addUsageToTotals,
	combineUsage,
	createUsageTotals,
	formatUsageCostNote,
	formatUsageTotalsCost,
	getUsageCostBreakdown,
} from "../src/core/usage-totals.ts";

const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const retiredModel = {
	provider: "google",
	id: "gemini-2.5-pro",
	type: "chat",
	cost: catalogueCost({ provider: "google", id: "gemini-2.5-pro", type: "chat", cost: rates }),
} as AnyModel;

function usage(asOf: string): Usage {
	const u: Usage = {
		input: 100_000,
		output: 100_000,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 200_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(retiredModel, u, asOf);
	return u;
}

const priced = () => usage("2026-11-30");
const unpriced = () => usage("2026-12-01");

// nredd/pi#83
describe("usage totals with unpriced entries", () => {
	it("calculateCost produces the marker only past retiredOn", () => {
		expect(priced().cost.unpriced).toBeUndefined();
		expect(priced().cost.total).toBeCloseTo(1.125);
		expect(unpriced().cost).toMatchObject({ total: 0, unpriced: true });
	});

	it("excludes unpriced entries from spend and counts them", () => {
		const totals = createUsageTotals();
		addUsageToTotals(totals, priced());
		addUsageToTotals(totals, unpriced());
		addUsageToTotals(totals, unpriced());
		expect(totals.cost).toBeCloseTo(1.125);
		expect(totals).toMatchObject({ pricedCount: 1, unpricedCount: 2 });
		expect(totals.input).toBe(300_000);
	});

	// nredd/pi#83: an aggregate keeps its priced spend and counts its unpriced requests.
	it("sums aggregates by their priced part and per-call unpriced count", () => {
		const aggregate = combineUsage(combineUsage(priced(), unpriced()), unpriced());
		expect(aggregate.cost).toMatchObject({ unpriced: true, unpricedCalls: 2 });
		const totals = createUsageTotals();
		addUsageToTotals(totals, aggregate);
		expect(totals.cost).toBeCloseTo(1.125);
		expect(totals).toMatchObject({ pricedCount: 1, unpricedCount: 2 });
		expect(formatUsageTotalsCost(totals)).toBe("$1.125 + 2 unpriced");
		// Aggregating only unpriced requests has no priced part: unknown, not $0.
		const only = createUsageTotals();
		addUsageToTotals(only, combineUsage(unpriced(), unpriced()));
		expect(formatUsageTotalsCost(only)).toBe("unknown");
	});

	it("formats priced, mixed, all-unpriced, and empty totals", () => {
		expect(formatUsageTotalsCost({ cost: 1.5, pricedCount: 2, unpricedCount: 0 })).toBe("$1.500");
		expect(formatUsageTotalsCost({ cost: 1.5, pricedCount: 2, unpricedCount: 3 })).toBe("$1.500 + 3 unpriced");
		expect(formatUsageTotalsCost({ cost: 0, pricedCount: 0, unpricedCount: 3 })).toBe("unknown");
		expect(formatUsageTotalsCost({ cost: 0, pricedCount: 0, unpricedCount: 0 })).toBeUndefined();
		// A legitimately free priced entry is $0.000 and not "unknown".
		expect(formatUsageTotalsCost({ cost: 0, pricedCount: 1, unpricedCount: 1 })).toBe("$0.000 + 1 unpriced");
	});

	it("renders the compaction and branch-summary cost note", () => {
		expect(formatUsageCostNote(priced().cost)).toBe(" (~$1.13)");
		expect(formatUsageCostNote(unpriced().cost)).toBe(" (cost unknown, unpriced)");
		expect(formatUsageCostNote(combineUsage(priced(), unpriced()).cost)).toBe(" (~$1.13 + unpriced)");
		expect(formatUsageCostNote({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 })).toBe("");
	});

	it("combineUsage keeps the marker when either side is unpriced", () => {
		expect(combineUsage(priced(), priced()).cost.unpriced).toBeUndefined();
		const combined = combineUsage(priced(), unpriced());
		expect(combined.cost).toMatchObject({ unpriced: true });
		expect(combined.cost.total).toBeCloseTo(1.125);
	});

	it("breakdown keeps unpriced models visible with their counts", () => {
		const message = (u: Usage, model: string) =>
			({
				type: "message",
				id: model,
				parentId: null,
				timestamp: "",
				message: { role: "assistant", provider: "google", model, usage: u },
			}) as never;
		const breakdown = getUsageCostBreakdown([
			message(priced(), "a"),
			message(unpriced(), "b"),
			message(unpriced(), "b"),
		]);
		expect(breakdown).toEqual([
			{ key: "google/a", cost: expect.closeTo(1.125), tokens: 200_000 },
			{ key: "google/b", cost: 0, tokens: 400_000, unpriced: 2, priced: 0 },
		]);
	});

	it("labels unpriced cache-warm transcript lines", () => {
		const entry = { usage: unpriced(), note: undefined } as unknown as UsageEntry;
		expect(formatCacheWarmingUsage(entry)).toBe("Cache warmed: unpriced");
		const pricedEntry = { usage: priced() } as unknown as UsageEntry;
		expect(formatCacheWarmingUsage(pricedEntry)).toMatch(/^Cache warmed: \$1\.125/);
	});
});

// nredd/pi#98
describe("priced versus zero-usage entries", () => {
	const zeroUsage = (): Usage => ({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	// A free priced model: real tokens, recorded cost $0 and not marked unpriced.
	const freePriced = (): Usage => ({
		input: 100_000,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	/** Label from entries added one by one. */
	const perEntry = (...usages: Usage[]) => {
		const totals = createUsageTotals();
		for (const u of usages) addUsageToTotals(totals, u);
		return formatUsageTotalsCost(totals);
	};
	/** Label from the same entries summed into one aggregate first. */
	const aggregate = (...usages: Usage[]) => perEntry(usages.reduce((sum, u) => combineUsage(sum, u)));

	it("does not count a zero-usage failed request as priced", () => {
		expect(perEntry(zeroUsage())).toBeUndefined();
		expect(perEntry(zeroUsage(), unpriced(), unpriced())).toBe("unknown");
		expect(aggregate(zeroUsage(), unpriced(), unpriced())).toBe("unknown");
	});

	it("agrees between per-entry and aggregate for a zero-usage failure plus unpriced", () => {
		const inputs = [zeroUsage(), unpriced(), unpriced()];
		expect(aggregate(...inputs)).toBe(perEntry(...inputs));
	});

	it("counts a free priced model as priced in both paths", () => {
		// Nothing to show: priced, but $0 and no unpriced entries (the footer hides it).
		expect(perEntry(freePriced())).toBeUndefined();
		expect(perEntry(freePriced(), unpriced())).toBe("$0.000 + 1 unpriced");
		expect(aggregate(freePriced(), unpriced())).toBe("$0.000 + 1 unpriced");
	});

	it("agrees between per-entry and aggregate for a free priced model plus unpriced", () => {
		const inputs = [freePriced(), unpriced(), unpriced()];
		expect(aggregate(...inputs)).toBe(perEntry(...inputs));
		expect(aggregate(...inputs)).toBe("$0.000 + 2 unpriced");
	});

	it("reads a legacy marked aggregate without pricedCalls by its priced subtotal", () => {
		const legacy = (total: number): Usage => ({
			...unpriced(),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, unpriced: true, unpricedCalls: 2 },
		});
		expect(perEntry(legacy(1.5))).toBe("$1.500 + 2 unpriced");
		expect(perEntry(legacy(0))).toBe("unknown");
	});

	it("keeps a free priced request apart from a zero-usage failure in an aggregate", () => {
		expect(aggregate(zeroUsage(), unpriced())).toBe("unknown");
		expect(aggregate(freePriced(), zeroUsage(), unpriced())).toBe("$0.000 + 1 unpriced");
	});
});

// nredd/pi#83
describe("session file round trip", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function assistant(u: Usage): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: u,
			stopReason: "stop",
			timestamp: 1,
		} as AssistantMessage;
	}

	it("persists and reloads the marker; old files without it load as priced", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-unpriced-"));
		dirs.push(dir);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "q", timestamp: 0 });
		manager.appendMessage(assistant(unpriced()));
		manager.appendMessage(assistant(priced()));
		const file = manager.getSessionFile();
		expect(file).toBeDefined();

		const lines = readFileSync(file as string, "utf8");
		expect(lines).toContain('"unpriced":true');

		const reloaded = SessionManager.open(file as string).getEntries();
		const costs = reloaded.flatMap((e) =>
			e.type === "message" && e.message.role === "assistant" ? [e.message.usage.cost] : [],
		);
		expect(costs).toHaveLength(2);
		expect(costs[0]).toMatchObject({ total: 0, unpriced: true });
		expect(costs[0].reason).toMatch(/retired/);
		expect(costs[1].unpriced).toBeUndefined();

		const totals = createUsageTotals();
		for (const e of reloaded)
			if (e.type === "message" && e.message.role === "assistant") addUsageToTotals(totals, e.message.usage);
		expect(formatUsageTotalsCost(totals)).toBe("$1.125 + 1 unpriced");

		// Old file: no marker anywhere -> every entry is priced.
		const old = createUsageTotals();
		addUsageToTotals(old, { ...priced(), cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } });
		expect(formatUsageTotalsCost(old)).toBe("$2.000");
	});
});

// nredd/pi#83
describe("HTML export header", () => {
	const template = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	/** Evaluate the template's real `computeStats` and `formatCostText` against synthetic entries. */
	function costText(costs: Array<Record<string, unknown> | undefined>): string {
		const grab = (name: string) => {
			const start = template.indexOf(`function ${name}(`);
			let depth = 0;
			for (let i = template.indexOf("{", start); i < template.length; i++) {
				if (template[i] === "{") depth++;
				if (template[i] === "}" && --depth === 0) return template.slice(start, i + 1);
			}
			throw new Error(name);
		};
		const context = { out: "" };
		vm.runInNewContext(
			`${grab("computeStats")}\n${grab("formatCostText")}
			const stats = computeStats(entries);
			const total = stats.cost.input + stats.cost.output + stats.cost.cacheRead + stats.cost.cacheWrite;
			out = formatCostText(stats.cost, total);`,
			Object.assign(context, {
				entries: costs.map((cost) => ({
					type: "message",
					message: { role: "assistant", content: [], usage: { input: 1, output: 1, cost } },
				})),
			}),
		);
		return context.out;
	}

	const pricedCost = { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 };
	const unpricedCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unpriced: true };

	it("prints the priced total plus the unpriced count", () => {
		expect(costText([pricedCost, unpricedCost, unpricedCost])).toBe("$0.300 + 2 unpriced");
	});

	it("prints unknown when everything is unpriced", () => {
		expect(costText([unpricedCost])).toBe("unknown");
	});

	it("renders old records without the marker as before", () => {
		expect(costText([pricedCost])).toBe("$0.300");
		expect(costText([undefined])).toBe("$0.000");
	});
});
