import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const publicModel: Model<"openai-responses"> = {
	id: "gpt-6.1-sol",
	provider: "openai",
	api: "openai-responses",
	name: "Public model",
	baseUrl: "https://example.test/v1",
	input: ["text"],
	reasoning: true,
	contextWindow: 272000,
	maxTokens: 128000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function builtin() {
	return createProvider({
		id: "openai",
		models: [publicModel],
		auth: {
			apiKey: {
				name: "Synthetic",
				resolve: async () => {
					throw new Error("No auth resolution permitted");
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
}
async function refresh(provider: Provider, store: InMemoryModelsStore, allowNetwork: boolean) {
	await provider.refreshModels?.({
		stored: await store.read(provider.id),
		allowNetwork,
		force: true,
		signal: new AbortController().signal,
		publish: async (publication: ModelsPublication) => {
			if (publication.persist) await store.write(provider.id, publication.persist);
			publication.update?.();
			return true;
		},
	});
}
afterEach(() => vi.restoreAllMocks());

// nredd/pi#46: bundled corrections must survive dynamic sources, but not override user prices.
describe("catalogue pricing precedence", () => {
	it.each([false, true])("corrects bundled and restored data, personalized=%s", async (personalized) => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Offline");
		});
		const provider = personalized
			? withPersonalizedCatalog(builtin(), async (models) => models)
			: withRemoteCatalog(builtin(), "https://example.test", 1);
		expect(provider.getModels()[0]?.cost.input).toBe(2);
		const store = new InMemoryModelsStore();
		await store.write("openai", {
			models: [{ ...publicModel, cost: { ...publicModel.cost, input: 999 } }],
			lastModified: 2,
		});
		await refresh(provider, store, false);
		expect(provider.getAllModels?.()[0]?.cost).toMatchObject({
			input: 2,
			cacheWrite12h: 5,
			assessment: { status: "verified" },
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	it("corrects fresh remote costs before the topmost explicit override", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([publicModel]), { headers: { "last-modified": "Thu, 12 Nov 2026 00:00:00 GMT" } }),
		);
		const provider = withRemoteCatalog(builtin(), "https://example.test", 1);
		await refresh(provider, new InMemoryModelsStore(), true);
		expect(provider.getModels()[0]?.cost.input).toBe(2);
		const home = await mkdtemp(join(tmpdir(), "pricing-override-"));
		try {
			const path = join(home, "models.json");
			await writeFile(
				path,
				JSON.stringify({
					providers: {
						openai: {
							modelOverrides: { "gpt-6.1-sol": { cost: { input: 7, cacheWrite1h: 9, cacheWrite12h: 11 } } },
						},
					},
				}),
			);
			const composed = composeModelProvider("openai", provider, await ModelConfig.load(path), undefined);
			expect(composed.getModels()[0]?.cost).toMatchObject({
				input: 7,
				cacheWrite1h: 9,
				cacheWrite12h: 11,
				assessment: { status: "unknown" },
			});
			await writeFile(
				path,
				JSON.stringify({
					providers: {
						openai: {
							modelOverrides: {
								"gpt-6.1-sol": {
									cost: {
										input: 8,
										assessment: {
											status: "verified",
											source: "https://example.test/pricing",
											checkedAt: "2026-11-12",
											unit: "usd-per-million-tokens",
											conditions: "Synthetic explicit override",
										},
									},
								},
							},
						},
					},
				}),
			);
			const assessed = composeModelProvider("openai", provider, await ModelConfig.load(path), undefined);
			expect(assessed.getModels()[0]?.cost).toMatchObject({
				input: 8,
				assessment: { status: "verified", source: "https://example.test/pricing" },
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
