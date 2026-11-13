import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// nredd/pi#66: a user override remains above the public paygo correction.
it("applies the broker correction before an explicit runtime override", async () => {
	const model: Model<"openai-responses"> = {
		id: "claude-haiku-4-5",
		provider: "opencode",
		api: "openai-responses",
		name: "Synthetic",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 100000,
		maxTokens: 4096,
		cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
	};
	const provider = createProvider({
		id: "opencode",
		models: [model],
		auth: {
			apiKey: {
				name: "Synthetic",
				resolve: async () => {
					throw new Error("Auth forbidden");
				},
			},
		},
		api: {
			stream: () => {
				throw new Error("Inference forbidden");
			},
			streamSimple: () => {
				throw new Error("Inference forbidden");
			},
		},
	});
	const remote = withRemoteCatalog(provider, "https://example.test", 1);
	expect(remote.getModels()[0]?.cost.input).toBe(1);
	const home = await mkdtemp(join(tmpdir(), "broker-override-"));
	try {
		const path = join(home, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: { opencode: { modelOverrides: { "claude-haiku-4-5": { cost: { input: 7 } } } } },
			}),
		);
		const composed = composeModelProvider("opencode", remote, await ModelConfig.load(path), undefined);
		expect(composed.getModels()[0]?.cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
		expect(model.cost.input).toBe(99);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
