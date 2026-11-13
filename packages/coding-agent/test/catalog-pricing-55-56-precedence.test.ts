import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, estimateTokenCost, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// nredd/pi#55/#56: actual runtime wrappers and topmost models.json overrides, no auth or inference.
it.each([false, true])(
	"corrects legacy feed data before an explicit user override, personalized=%s",
	async (personalized) => {
		const home = await mkdtemp(join(tmpdir(), "feed-pricing-precedence-"));
		const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network permitted"));
		try {
			for (const [providerId, id, expected] of [
				["openrouter", "anthropic/claude-haiku-5.5", 0.1],
				["vercel-ai-gateway", "alibaba/qwen-3-14b", 0.12],
			] as const) {
				const model: Model<"anthropic-messages"> = {
					provider: providerId,
					id,
					name: "Synthetic legacy catalogue",
					api: "anthropic-messages",
					baseUrl: "https://example.test",
					input: ["text"],
					contextWindow: 1000000,
					maxTokens: 1000,
					reasoning: false,
					cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
				};
				const base = createProvider({
					id: providerId,
					models: [model],
					auth: {
						apiKey: {
							name: "Synthetic",
							resolve: async () => {
								throw new Error("No auth permitted");
							},
						},
					},
					api: {
						stream: () => {
							throw new Error("No inference permitted");
						},
						streamSimple: () => {
							throw new Error("No inference permitted");
						},
					},
				});
				const provider = personalized
					? withPersonalizedCatalog(base, async (models) => models)
					: withRemoteCatalog(base, "https://example.test", 1);
				const store = new InMemoryModelsStore();
				await store.write(providerId, { models: [model], lastModified: 1 });
				await provider.refreshModels?.({
					stored: await store.read(providerId),
					allowNetwork: false,
					signal: new AbortController().signal,
					publish: async (publication) => {
						publication.update?.();
						return true;
					},
				});
				const projected = provider.getModels()[0];
				expect(projected.cost.input).toBe(expected);
				expect(projected.cost.assessment).toMatchObject({ status: "verified", checkedAt: "2026-11-13" });
				expect(
					estimateTokenCost(projected, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }).cost?.input,
				).toBeCloseTo(expected / 1_000_000, 12);
				expect(model.cost.input).toBe(999);
				const path = join(home, "models.json");
				await writeFile(
					path,
					JSON.stringify({ providers: { [providerId]: { modelOverrides: { [id]: { cost: { input: 7 } } } } } }),
				);
				const composed = composeModelProvider(providerId, provider, await ModelConfig.load(path), undefined);
				expect(composed.getModels()[0].cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
			}
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
			await rm(home, { recursive: true, force: true });
		}
	},
);
