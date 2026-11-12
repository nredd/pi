/** Operating-context policy, independent of summary output and retained-history budgets. */
export type CompactionTarget = "auto" | "contextWindow" | number;

export interface CompactionPolicy {
	/** Undefined means capacity is unknown, not an invented context window. */
	inputBudget: number | undefined;
	targetTokens: number;
	threshold: number;
	evidence: "application-fallback" | "explicit" | "legacy";
}

/** Validate settings even when a more specific override would mask them. */
export function validateCompactionTarget(value: unknown, path: string): asserts value is CompactionTarget | undefined {
	if (value === undefined || value === "auto" || value === "contextWindow") return;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return;
	throw new Error(`Invalid ${path}: ${String(value)}. Expected "auto", "contextWindow", or a positive safe integer.`);
}

/**
 * Resolve a working target. No provider recommendations currently qualify for Pi's
 * client-side summary surface. The fallback is application policy, not quality evidence.
 * `maxInputTokens` is a hard input ceiling; output reserve is not subtracted from it again.
 */
export function resolveCompactionPolicy(
	contextWindow: number,
	reserveTokens: number,
	target: CompactionTarget = "auto",
	maxInputTokens?: number,
): CompactionPolicy {
	validateCompactionTarget(target, "compaction.targetTokens");
	if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0) {
		throw new Error("Invalid compaction.reserveTokens: expected a non-negative safe integer.");
	}
	if (!Number.isSafeInteger(contextWindow) || contextWindow < 0) {
		throw new Error("Invalid model contextWindow: use 0 for unknown capacity or a positive safe integer.");
	}
	if (maxInputTokens !== undefined && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0)) {
		throw new Error("Invalid inputLimits.maxInputTokens: expected a positive safe integer.");
	}
	let inputBudget = contextWindow > 0 ? contextWindow - reserveTokens : undefined;
	if (maxInputTokens !== undefined) inputBudget = Math.min(inputBudget ?? Infinity, maxInputTokens);
	if (inputBudget !== undefined && inputBudget <= 0) {
		throw new Error("No input budget remains. Reduce compaction.reserveTokens or correct the model's hard limits.");
	}
	const targetTokens =
		target === "contextWindow"
			? (inputBudget ?? Infinity)
			: target === "auto"
				? Math.min(128000, inputBudget === undefined ? 128000 : Math.floor(0.5 * inputBudget))
				: target;
	if (targetTokens <= 0) {
		throw new Error("No positive compaction target remains. Correct the model's hard limits or reserveTokens.");
	}
	return {
		inputBudget,
		targetTokens,
		threshold: Math.min(inputBudget ?? Infinity, targetTokens),
		evidence: target === "auto" ? "application-fallback" : target === "contextWindow" ? "legacy" : "explicit",
	};
}
