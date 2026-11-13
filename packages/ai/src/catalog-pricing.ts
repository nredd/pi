import brokerPrices from "./broker-pricing-data.json" with { type: "json" };
import type { AnyModel, ModelCost, ModelCostRates, Usage } from "./types.ts";

/** Official standard/global list prices checked on this date, not request-date bills. */
export const PRICING_CHECKED_AT = "2026-11-12";
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const GOOGLE_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

/** Existing generator corrections, shared with runtime overlays. USD per million tokens. */
export const OPENAI_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.5-pro": { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5.4-pro": { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
	"gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
	"gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
	"gpt-5.2-pro": { input: 21, output: 168, cacheRead: 0, cacheWrite: 0 },
	"gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	"gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	"gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
	"gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
	"gpt-5-pro": { input: 15, output: 120, cacheRead: 0, cacheWrite: 0 },
	"gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
	"gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
	"gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
	"o3-pro": { input: 20, output: 80, cacheRead: 0, cacheWrite: 0 },
	o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
};

export const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
export const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);
// Only exact mappings already declared by the generator's subscription catalogue.
const CODEX_API_EQUIVALENT_IDS = new Set([
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);

/** Published OpenAI Standard long-context policy, shared by generation and runtime correction. */
export function withOpenAiLongContextPricing(cost: ModelCost): ModelCost {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: Number((cost.input * 2).toFixed(6)),
				output: Number((cost.output * 1.5).toFixed(6)),
				cacheRead: Number((cost.cacheRead * 2).toFixed(6)),
				cacheWrite: Number((cost.cacheWrite * 2).toFixed(6)),
				...(cost.cacheWrite12h !== undefined ? { cacheWrite12h: Number((cost.cacheWrite12h * 2).toFixed(6)) } : {}),
			},
		],
	};
}

function verified(
	cost: ModelCost,
	source: string,
	conditions: string,
	unavailable: ("input" | "output" | "cacheRead" | "cacheWrite")[] = [],
	checkedAt = PRICING_CHECKED_AT,
): ModelCost {
	return {
		...cost,
		assessment: {
			status: "verified",
			source,
			checkedAt,
			unit: "usd-per-million-tokens",
			conditions,
			unavailable,
		},
	};
}

type BrokerRates = { input: number; output: number; cacheRead: number; cacheWrite?: number };
type BrokerRow = BrokerRates & { tiers?: (BrokerRates & { inputTokensAbove: number })[] };

// Public source snapshots contain only exact archived catalogue selectors, not account routes.
function brokerCost(provider: string, id: string, previous: ModelCost): ModelCost | undefined {
	const radius = brokerPrices.radius as Record<string, { free: boolean; cost: BrokerRow }>;
	const opencode = brokerPrices.opencode as Record<string, BrokerRow>;
	const entry = provider === "radius" && Object.hasOwn(radius, id) ? radius[id] : undefined;
	const row = entry?.cost ?? (provider === "opencode" && Object.hasOwn(opencode, id) ? opencode[id] : undefined);
	if (!row || (entry && typeof entry.free !== "boolean")) return undefined;
	const tiers = row.tiers ?? [];
	if (!Array.isArray(tiers)) return undefined;
	if (entry && !entry.free && [row.input, row.output, row.cacheRead, row.cacheWrite].every((value) => value === 0))
		return undefined;
	let threshold = -1;
	for (const rate of [row, ...tiers]) {
		if (!rate || typeof rate !== "object" || Array.isArray(rate)) return undefined;
		const values = [rate.input, rate.output, rate.cacheRead, ...(entry ? [rate.cacheWrite] : [])];
		if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return undefined;
		if (entry?.free && values.some((value) => value !== 0)) return undefined;
		if (rate !== row) {
			if (!("inputTokensAbove" in rate) || !Number.isSafeInteger(rate.inputTokensAbove)) return undefined;
			if (rate.inputTokensAbove <= threshold) return undefined;
			threshold = rate.inputTokensAbove;
		}
	}
	const rates = (rate: BrokerRates): ModelCostRates => ({
		input: rate.input,
		output: rate.output,
		cacheRead: rate.cacheRead,
		cacheWrite: rate.cacheWrite ?? previous.cacheWrite,
	});
	const cost: ModelCost = {
		...rates(row),
		...(tiers.length
			? { tiers: tiers.map((tier) => ({ ...rates(tier), inputTokensAbove: tier.inputTokensAbove })) }
			: {}),
	};
	const source = entry ? "https://radius.pi.dev/v1/model-pricing" : "https://opencode.ai/docs/zen/";
	const conditions = entry
		? "Anonymous Radius public list, not organization pricing; cache-write retention is unverified."
		: "OpenCode pay-as-you-go token rates; cache-write retention and credit-purchase fees are excluded.";
	const assessed = verified(cost, source, conditions, ["cacheWrite"], "2026-11-13");
	if (entry?.free && assessed.assessment?.status === "verified") assessed.assessment.status = "free";
	return assessed;
}

// Rates and bounds are one contract so a dated alias cannot acquire only one of them.
const HAIKU_45 = {
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
	maxContextTokens: 200000,
	maxOutputTokens: 64000,
};
const OPUS_45 = {
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
	maxContextTokens: 200000,
	maxOutputTokens: 64000,
};
const SONNET_45 = {
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
	maxContextTokens: 200000,
	maxOutputTokens: 64000,
	retiredOn: "2026-11-30",
};
const BOUNDED_ANTHROPIC: Record<
	string,
	{ cost: ModelCost; maxContextTokens: number; maxOutputTokens: number; retiredOn?: string }
> = {
	"claude-fable-5-2": {
		cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
		maxContextTokens: 1000000,
		maxOutputTokens: 128000,
	},
	"claude-haiku-4-5": HAIKU_45,
	"claude-haiku-4-5-20251001": HAIKU_45,
	"claude-opus-4-5": OPUS_45,
	"claude-opus-4-5-20251101": OPUS_45,
	"claude-sonnet-4-5": SONNET_45,
	"claude-sonnet-4-5-20250929": SONNET_45,
};

/** Apply narrow official corrections before user overrides, never infer a provider from a model name. */
export function catalogueCost(model: Pick<AnyModel, "provider" | "id" | "type" | "cost">): ModelCost {
	const type = model.type ?? "chat";
	const codexTerra = type === "chat" && model.provider === "openai-codex" && model.id === "gpt-6.1-terra";
	const boundedAnthropicContract =
		type === "chat" && model.provider === "anthropic" && Object.hasOwn(BOUNDED_ANTHROPIC, model.id)
			? BOUNDED_ANTHROPIC[model.id]
			: undefined;
	const previous = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const broker = type === "chat" ? brokerCost(model.provider, model.id, previous) : undefined;
	const checkedAt = codexTerra || boundedAnthropicContract || broker ? "2026-11-13" : PRICING_CHECKED_AT;
	// A newer explicitly assessed catalog must not be frozen at this client's audit date.
	if (
		previous.assessment?.status !== "unknown" &&
		previous.assessment?.checkedAt &&
		previous.assessment.checkedAt > checkedAt
	)
		return previous;
	if (broker) return broker;
	if (
		type === "chat" &&
		(model.provider === "openai" || (model.provider === "openai-codex" && CODEX_API_EQUIVALENT_IDS.has(model.id)))
	) {
		const base = Object.hasOwn(OPENAI_STANDARD_COSTS, model.id) ? OPENAI_STANDARD_COSTS[model.id] : undefined;
		if (base) {
			const cost = { ...base, ...(base.cacheWrite > 0 ? { cacheWrite12h: base.cacheWrite * 2 } : {}) };
			return verified(
				OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(model.id) ? withOpenAiLongContextPricing(cost) : cost,
				OPENAI_SOURCE,
				"Standard, global; explicitly listed cache lifetimes only; API-equivalent, not subscription charges. Regional, Batch, Flex, Fast and Ultrafast excluded." +
					(codexTerra
						? " Exact Codex selector: https://developers.openai.com/codex/models; API model: https://developers.openai.com/api/docs/models/gpt-6.1-terra.md."
						: ""),
				[
					...(base.cacheWrite === 0 ? ["cacheWrite" as const] : []),
					...(base.cacheRead === 0 ? ["cacheRead" as const] : []),
				],
				checkedAt,
			);
		}
	}
	if (type === "chat" && model.provider === "anthropic") {
		const direct: Record<string, ModelCost> = {
			"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
			"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
			"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
			"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
			"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
			"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
			"claude-haiku-5-5": {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				cacheWrite1h: 0.2,
				tiers: [
					{
						inputTokensAbove: 100000,
						input: 0.5,
						output: 2.5,
						cacheRead: 0.05,
						cacheWrite: 0.625,
						cacheWrite1h: 1,
					},
				],
			},
		};
		const cost = boundedAnthropicContract?.cost ?? (Object.hasOwn(direct, model.id) ? direct[model.id] : undefined);
		if (cost) {
			const assessed = verified(
				cost,
				ANTHROPIC_SOURCE,
				"Standard, global first-party; 5m or 1h writes. Batch and US-only inference uplift excluded.",
				[],
				checkedAt,
			);
			if (boundedAnthropicContract && assessed.assessment?.status === "verified") {
				const { maxContextTokens, maxOutputTokens, retiredOn } = boundedAnthropicContract;
				assessed.assessment = {
					...assessed.assessment,
					maxContextTokens,
					maxOutputTokens,
					...(retiredOn ? { retiredOn } : {}),
				};
			}
			return assessed;
		}
	}
	if (type === "chat" && model.provider === "amazon-bedrock") {
		// Normalize only AWS's public profile prefixes and exact physical IDs, never fuzzy aliases.
		const id = model.id.replace(/^(global|us|eu|apac|au|jp|in|ca)\./, "");
		// Independent AWS Global Cross-region Inference table, not direct Anthropic substitution.
		const baseline: Record<string, ModelCost> = {
			"anthropic.claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
			"anthropic.claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
			"anthropic.claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
			"anthropic.claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
			"anthropic.claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
			"anthropic.claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
			"anthropic.claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
			"anthropic.claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"anthropic.claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"anthropic.claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"anthropic.claude-opus-4-6-v1": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
			"anthropic.claude-opus-4-5-20251101-v1:0": {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
				cacheWrite1h: 10,
			},
			"anthropic.claude-haiku-4-5-20251001-v1:0": {
				input: 1,
				output: 5,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				cacheWrite1h: 2,
			},
			"anthropic.claude-haiku-5-5": {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				cacheWrite1h: 0.2,
				tiers: [
					{
						inputTokensAbove: 100000,
						input: 0.5,
						output: 2.5,
						cacheRead: 0.05,
						cacheWrite: 0.625,
						cacheWrite1h: 1,
					},
				],
			},
		};
		if (Object.hasOwn(baseline, id))
			return verified(
				baseline[id],
				"https://aws.amazon.com/bedrock/pricing/",
				"Published baseline: USD per 1M tokens, Standard/on-demand, Global Cross-region Inference table, US East (N. Virginia) selector. All listed profile IDs are normalized to this baseline, NOT actual regional/profile invoice prices. 5m/1h writes; Batch, Flex, Priority, Reserved, discounts and regional uplifts excluded.",
			);
	}
	if (type === "chat" && model.provider === "google" && model.id === "gemini-2.5-pro") {
		return verified(
			{
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
				tiers: [{ inputTokensAbove: 200000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }],
			},
			GOOGLE_SOURCE,
			"Paid Standard token charges only; cache storage at USD 4.50 per million tokens/hour is excluded. No Vertex substitution.",
			["cacheWrite"],
		);
	}
	return {
		...previous,
		assessment: previous.assessment ?? {
			status: "unknown",
			reason:
				type === "image"
					? "Non-token image charges are not supported by token valuation."
					: model.provider === "amazon-bedrock"
						? "No verified exact physical-model mapping to the published Bedrock baseline."
						: "Official rates or exact alias mapping have not been verified.",
		},
	};
}

/** Select the request-wide tier using all input, including cached input. */
export function costRates(cost: ModelCost, inputTokens: number): ModelCostRates {
	let rates: ModelCostRates = cost;
	let threshold = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier;
			threshold = tier.inputTokensAbove;
		}
	}
	return rates;
}

/** Shared request-time arithmetic. Legacy unassessed one-hour prices retain their old fallback. */
export function calculateTokenCost(cost: ModelCost, usage: Usage & { cacheWrite12h?: number }): Usage["cost"] {
	const rates = costRates(cost, usage.input + usage.cacheRead + usage.cacheWrite);
	const oneHour = usage.cacheWrite1h ?? 0;
	const twelveHour = usage.cacheWrite12h ?? 0;
	const short = usage.cacheWrite - oneHour - twelveHour;
	usage.cost.input = (rates.input / 1_000_000) * usage.input;
	usage.cost.output = (rates.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite =
		(rates.cacheWrite * short +
			(rates.cacheWrite1h ?? rates.input * 2) * oneHour +
			(rates.cacheWrite12h ?? 0) * twelveHour) /
		1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

export interface PricingTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	cacheWrite12h?: number;
	/** Explicitly known remaining writes use the catalog's short-retention rate. */
	shortCacheWrites?: boolean;
}

export type CostEstimate = { cost: Usage["cost"]; reason?: never } | { cost: null; reason: string };

/** Offline current-list-price estimate. Does not mutate usage, transcripts or recorded costs. */
export function estimateTokenCost(
	model: Pick<AnyModel, "type" | "cost"> | undefined,
	tokens: PricingTokens,
	asOf = new Date().toISOString().slice(0, 10),
): CostEstimate {
	if (!model?.cost) return { cost: null, reason: "Model or exact alias mapping is unavailable." };
	if (model.type === "image") return { cost: null, reason: "Non-token image accounting is unsupported." };
	const assessment = model.cost.assessment;
	if (!assessment || assessment.status === "unknown")
		return { cost: null, reason: assessment?.reason ?? "Rates have not been verified." };
	if (
		(assessment.status !== "verified" && assessment.status !== "free") ||
		assessment.unit !== "usd-per-million-tokens" ||
		typeof assessment.source !== "string" ||
		!assessment.source ||
		typeof assessment.conditions !== "string" ||
		!assessment.conditions ||
		typeof assessment.checkedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(assessment.checkedAt)
	)
		return { cost: null, reason: "Invalid pricing assessment." };
	if (
		(assessment.unavailable !== undefined &&
			(!Array.isArray(assessment.unavailable) ||
				assessment.unavailable.some((field) => !["input", "output", "cacheRead", "cacheWrite"].includes(field)))) ||
		(model.cost.tiers !== undefined &&
			(!Array.isArray(model.cost.tiers) ||
				model.cost.tiers.some(
					(tier) => !tier || !Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove < 0,
				)))
	)
		return { cost: null, reason: "Invalid pricing metadata." };
	if (assessment.unavailable?.some((field) => tokens[field] > 0))
		return { cost: null, reason: "A consumed token category has no applicable token rate." };
	const counts = [
		tokens.input,
		tokens.output,
		tokens.cacheRead,
		tokens.cacheWrite,
		tokens.cacheWrite1h ?? 0,
		tokens.cacheWrite12h ?? 0,
	];
	if (
		counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
		!Number.isSafeInteger(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite)
	)
		return { cost: null, reason: "Invalid token counters." };
	const validDate = (date: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(date) &&
		!Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
		new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
	if (!validDate(asOf)) return { cost: null, reason: "Invalid evaluation date." };
	if (asOf < assessment.checkedAt) return { cost: null, reason: "Evaluation date precedes the verified price check." };
	for (const limit of [assessment.maxContextTokens, assessment.maxOutputTokens])
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
			return { cost: null, reason: "Invalid pricing metadata." };
	if (
		assessment.retiredOn !== undefined &&
		(typeof assessment.retiredOn !== "string" || !validDate(assessment.retiredOn))
	)
		return { cost: null, reason: "Invalid pricing metadata." };
	if (assessment.retiredOn && asOf >= assessment.retiredOn)
		return { cost: null, reason: "Model contract is retired." };
	if (assessment.maxOutputTokens !== undefined && tokens.output > assessment.maxOutputTokens)
		return { cost: null, reason: "Output exceeds the verified contract." };
	if (
		assessment.maxContextTokens !== undefined &&
		tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > assessment.maxContextTokens
	)
		return { cost: null, reason: "Request context exceeds the verified contract." };
	const oneHour = tokens.cacheWrite1h ?? 0;
	const twelveHour = tokens.cacheWrite12h ?? 0;
	if (oneHour + twelveHour > tokens.cacheWrite)
		return { cost: null, reason: "Cache lifetime counters exceed total writes." };
	if (tokens.cacheWrite > oneHour + twelveHour && !tokens.shortCacheWrites)
		return { cost: null, reason: "Cache-write lifetime is unavailable." };
	const rates = costRates(model.cost, tokens.input + tokens.cacheRead + tokens.cacheWrite);
	if ((oneHour > 0 && rates.cacheWrite1h === undefined) || (twelveHour > 0 && rates.cacheWrite12h === undefined))
		return { cost: null, reason: "Cache-write lifetime price is unavailable." };
	const values = [model.cost, ...(model.cost.tiers ?? [])].flatMap((rate) => [
		rate.input,
		rate.output,
		rate.cacheRead,
		rate.cacheWrite,
		rate.cacheWrite1h === undefined ? 0 : rate.cacheWrite1h,
		rate.cacheWrite12h === undefined ? 0 : rate.cacheWrite12h,
	]);
	if (
		values.some((rate) => !Number.isFinite(rate) || rate < 0) ||
		(assessment.status === "free" && values.some((rate) => rate !== 0))
	)
		return { cost: null, reason: "Invalid or inconsistent price metadata." };
	return {
		cost: calculateTokenCost(model.cost, {
			...tokens,
			totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}),
	};
}
