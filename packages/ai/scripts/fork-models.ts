import { OPENAI_STANDARD_COSTS, withOpenAiLongContextPricing } from "../src/catalog-pricing.ts";
import type { Api, Model } from "../src/types.ts";

// Public cards checked 2026-11-17, not evidence of Azure deployments or account availability:
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
// https://developers.openai.com/api/docs/models/gpt-6.2-astra
export const GPT_62_MODELS = [
	{ id: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
	{ id: "gpt-6.2-astra", name: "GPT-6.2 Astra" },
] as const;

/** Fork additions shared by live generation and frozen offline builds. No feed data is consulted. */
export function forkModels(provider: "openai" | "openai-codex"): Model<Api>[] {
	return GPT_62_MODELS.map(({ id, name }) => ({
		type: "chat",
		id,
		name,
		provider,
		api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
		baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		// Keep #117's unknown assessment. Numeric compatibility rates are not an audited estimate.
		cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[id]),
		// The documented 1.05M API window is opt-in, not the default or a Codex limit claim.
		contextWindow: 272000,
		maxTokens: 128000,
		inputLimits: {
			...(provider === "openai" ? { maxInputTokens: 922000, maxRequestBytes: 512 * 1024 * 1024 } : {}),
			images: {
				...(provider === "openai" ? { maxPerRequest: 1500 } : {}),
				resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 80 },
			},
		},
		compat: {
			supportsOpenAIGrammarTools: true,
			...(provider === "openai"
				? {
						supportsToolSearch: true,
						supportsAdditionalTools: true,
						supportsStrictMode: true,
						supportsExplicitPromptCacheMode: true,
					}
				: {}),
		},
	}));
}
