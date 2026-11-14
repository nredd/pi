import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Spend of priced usage only; unpriced usage is excluded, never counted as $0. */
	cost: number;
	/** Entries whose cost was recorded as priced (including legitimately free ones). */
	pricedCount: number;
	/** Entries marked `cost.unpriced`: real tokens the catalogue could not price. */
	unpricedCount: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		pricedCount: 0,
		unpricedCount: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	if (usage.cost.unpriced) {
		totals.unpricedCount += 1;
	} else {
		totals.cost += usage.cost.total;
		totals.pricedCount += 1;
	}
}

/**
 * Render a cost total for the footer, `/session`, exports and notices. Priced spend prints as `$x`;
 * unpriced entries add "N unpriced"; when every entry is unpriced the cost is "unknown", never $0.
 * Returns undefined when there is nothing to show (no cost and nothing unpriced).
 */
export function formatUsageTotalsCost(
	totals: Pick<UsageTotals, "cost" | "pricedCount" | "unpricedCount">,
	digits = 3,
): string | undefined {
	if (totals.unpricedCount > 0 && totals.pricedCount === 0) return "unknown";
	const priced = `$${totals.cost.toFixed(digits)}`;
	if (totals.unpricedCount > 0) return `${priced} + ${totals.unpricedCount} unpriced`;
	return totals.cost > 0 ? priced : undefined;
}

/** Parenthesised cost suffix for a compaction or branch-summary notice; empty below one cent. */
export function formatUsageCostNote(cost: Usage["cost"]): string {
	const spend = cost.total >= 0.01 ? `~$${cost.total.toFixed(2)}` : undefined;
	if (cost.unpriced) return spend ? ` (${spend} + unpriced)` : " (cost unknown, unpriced)";
	return spend ? ` (${spend})` : "";
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			// The sum is a priced subtotal when either side was unpriced.
			...(first.cost.unpriced || second.cost.unpriced
				? {
						unpriced: true as const,
						...((first.cost.reason ?? second.cost.reason) !== undefined
							? { reason: (first.cost.reason ?? second.cost.reason) as string }
							: {}),
					}
				: {}),
		},
	};
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
	/** Set only when entries under this key were unpriced (excluded from `cost`). */
	unpriced?: number;
	/** Set only with `unpriced`: how many entries under this key were priced. */
	priced?: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "usage") {
			key = `${entry.provider}/${entry.model}`;
			usage = entry.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		...(totals.unpricedCount > 0 ? { unpriced: totals.unpricedCount, priced: totals.pricedCount } : {}),
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0 || entry.unpriced)
		.sort((a, b) => b.cost - a.cost);
}
