import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// nredd/pi#60, #62, #63: runtime correction precedes explicit user pricing overrides.
it.each([
	["cerebras", "gpt-oss-120b", 0.35],
	["xai", "grok-4.7", 2],
	["google", "gemini-3.5-flash-lite", 0.3],
] as const)("corrects and overrides %s/%s", async (providerId, id, input) => {
	const model: Model<"openai-completions"> = {
		id,
		provider: providerId,
		api: "openai-completions",
		name: id,
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
		cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
	};
	const base = createProvider({
		id: providerId,
		models: [model],
		auth: {
			apiKey: {
				name: "Synthetic",
				resolve: async () => {
					throw new Error("Auth prohibited");
				},
			},
		},
		api: {
			stream: () => {
				throw new Error("Inference prohibited");
			},
			streamSimple: () => {
				throw new Error("Inference prohibited");
			},
		},
	});
	const provider = withRemoteCatalog(base, "https://example.test", 1);
	expect(provider.getModels()[0]?.cost).toMatchObject({
		input,
		assessment: { status: "verified", checkedAt: "2026-11-13" },
	});
	const home = await mkdtemp(join(tmpdir(), "pricing-family-override-"));
	try {
		const path = join(home, "models.json");
		await writeFile(
			path,
			JSON.stringify({ providers: { [providerId]: { modelOverrides: { [id]: { cost: { input: 7 } } } } } }),
		);
		const composed = composeModelProvider(providerId, provider, await ModelConfig.load(path), undefined);
		expect(composed.getModels()[0]?.cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
