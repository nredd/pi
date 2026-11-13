import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AnyModel,
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
	it.each([false, true])("preserves projected model identities and live metadata, personalized=%s", (personalized) => {
		const chat = { ...publicModel, cost: { ...publicModel.cost } };
		const models: AnyModel[] = [
			chat,
			{ ...publicModel, id: "synthetic-image", type: "image", api: "openrouter-images", output: ["image"] },
			{ ...publicModel, id: "synthetic-classifier", type: "classifier", api: "typesafe-system-one" },
		];
		const source = { ...builtin(), getModels: () => [chat], getAllModels: () => models };
		const provider = personalized
			? withPersonalizedCatalog(source, async (models) => models)
			: withRemoteCatalog(source, "https://example.test", 1);
		const first = provider.getAllModels?.() ?? [];
		expect(first).toHaveLength(3);
		for (const [index, model] of (provider.getAllModels?.() ?? []).entries()) expect(model).toBe(first[index]);
		chat.name = "Updated synthetic metadata";
		chat.cost = { ...chat.cost, input: 999 };
		chat.promptCache = { short: 60 };
		const updated = provider.getModels()[0];
		expect(updated).toBe(first[0]);
		expect(updated).toMatchObject({ name: chat.name, cost: { input: 2 }, promptCache: { short: 60 } });
		expect(chat.cost.input).toBe(999);
		delete chat.promptCache;
		expect(provider.getModels()[0]?.promptCache).toBeUndefined();
		chat.cost = {
			...chat.cost,
			input: 7,
			assessment: {
				status: "verified",
				source: "https://example.test/pricing",
				checkedAt: "2026-11-13",
				unit: "usd-per-million-tokens",
				conditions: "Synthetic newer assessment",
			},
		};
		expect(provider.getModels()[0]).toBe(first[0]);
		expect(provider.getModels()[0]?.cost.input).toBe(7);
	});
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
	it.each([false, true])(
		"corrects a successful personalized network refresh but preserves newer assessment=%s",
		async (newer) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify([{ ...publicModel, cost: { ...publicModel.cost, input: 999 } }]), {
					headers: { "last-modified": "Thu, 12 Nov 2026 00:00:00 GMT" },
				}),
			);
			const personalize = vi.fn(async (models: readonly AnyModel[]) => {
				expect(models[0]?.cost.input).toBe(2);
				return models.map((model) => ({
					...model,
					cost: {
						...model.cost,
						input: 7,
						...(newer
							? {
									assessment: {
										status: "verified" as const,
										source: "https://example.test/pricing",
										checkedAt: "2026-11-13",
										unit: "usd-per-million-tokens" as const,
										conditions: "Synthetic newer assessment",
									},
								}
							: {}),
					},
				}));
			});
			const provider = withPersonalizedCatalog(builtin(), personalize, "https://example.test", 1);
			const store = new InMemoryModelsStore();
			await refresh(provider, store, true);
			expect(personalize).toHaveBeenCalledOnce();
			expect(globalThis.fetch).toHaveBeenCalledOnce();
			expect(provider.getModels()[0]?.cost.input).toBe(newer ? 7 : 2);
			const restored = withPersonalizedCatalog(
				builtin(),
				async () => {
					throw new Error("Offline refresh must not personalize");
				},
				"https://example.test",
				1,
			);
			await refresh(restored, store, false);
			expect(restored.getModels()[0]?.cost.input).toBe(newer ? 7 : 2);
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		},
	);
	// nredd/pi#54: exact Responses correction precedes explicit user cost overrides.
	it("preserves the user override after the Codex 5.3 correction", async () => {
		const model = { ...publicModel, id: "gpt-5.3-codex", contextWindow: 400000 };
		const source = { ...builtin(), getModels: () => [model], getAllModels: () => [model] };
		const provider = withRemoteCatalog(source, "https://example.test", 1);
		expect(provider.getModels()[0]?.cost).toMatchObject({ input: 1.75, assessment: { maxInputTokens: 272000 } });
		const home = await mkdtemp(join(tmpdir(), "pricing-codex-override-"));
		try {
			const path = join(home, "models.json");
			await writeFile(
				path,
				JSON.stringify({ providers: { openai: { modelOverrides: { "gpt-5.3-codex": { cost: { input: 7 } } } } } }),
			);
			const composed = composeModelProvider("openai", provider, await ModelConfig.load(path), undefined);
			expect(composed.getModels()[0]?.cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
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
