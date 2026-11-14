import type { Usage } from "../types.ts";

/**
 * Priced requests in one usage: billable tokens or a nonzero cost. A zero-usage request (one that failed
 * before `message_start`) is neither priced nor unpriced. A marked aggregate carries its count; a legacy one
 * without it falls back to its priced subtotal, which is exact for zero versus nonzero.
 */
export function pricedCallsOf(usage: Usage): number {
	if (usage.cost.unpriced) return usage.cost.pricedCalls ?? (usage.cost.total > 0 ? 1 : 0);
	const billable = usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
	return billable || usage.cost.total > 0 ? 1 : 0;
}

/** Unpriced requests in one usage: a marked aggregate counts its summed calls, a single marked request once. */
export function unpricedCallsOf(usage: Usage): number {
	return usage.cost.unpriced ? (usage.cost.unpricedCalls ?? 1) : 0;
}
