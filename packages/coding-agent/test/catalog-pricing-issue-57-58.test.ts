import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// nredd/pi#57 and #58: restored legacy prices are corrected before explicit user overrides.
it.each(["amazon.nova-lite-v1:0", "global.openai.gpt-6.1-terra"])(
	"preserves override precedence for %s",
	async (id) => {
		const model: Model<"bedrock-converse-stream"> = {
			id,
			provider: "amazon-bedrock",
			api: "bedrock-converse-stream",
			name: "Synthetic",
			baseUrl: "https://example.test",
			input: ["text"],
			reasoning: false,
			contextWindow: 10000,
			maxTokens: 1000,
			cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
		};
		const base = createProvider({
			id: "amazon-bedrock",
			models: [model],
			auth: {},
			api: {
				stream: () => {
					throw new Error("No inference permitted");
				},
				streamSimple: () => {
					throw new Error("No inference permitted");
				},
			},
		});
		const provider = withRemoteCatalog(base, "https://example.test", 1);
		const store = new InMemoryModelsStore();
		await store.write("amazon-bedrock", { models: [model], lastModified: 2 });
		await provider.refreshModels?.({
			stored: await store.read("amazon-bedrock"),
			allowNetwork: false,
			force: true,
			signal: new AbortController().signal,
			publish: async (p) => {
				p.update?.();
				return true;
			},
		});
		expect(provider.getModels()[0]?.cost.input).toBe(id.startsWith("amazon.") ? 0.06 : 1);
		const home = await mkdtemp(join(tmpdir(), "bedrock-override-"));
		try {
			const path = join(home, "models.json");
			await writeFile(
				path,
				JSON.stringify({ providers: { "amazon-bedrock": { modelOverrides: { [id]: { cost: { input: 7 } } } } } }),
			);
			const composed = composeModelProvider("amazon-bedrock", provider, await ModelConfig.load(path), undefined);
			expect(composed.getModels()[0]?.cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	},
);
