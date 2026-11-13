import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	calculateCost,
	catalogueCost,
	createProvider,
	estimateTokenCost,
	type Model,
	type Provider,
	type Usage,
} from "@earendil-works/pi-ai";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

// nredd/pi#55 and #56: the key's live `/models/user` price must survive the pricing projection, while stale
// built-in or pi.dev catalogue rows are still corrected to the archived feed.
const FEED_ID = "anthropic/claude-haiku-5.5"; // archived base prompt 0.0000001 => 0.1 USD/M
const NOT_IN_FEED_ID = "synthetic/not-in-feed";
const LIVE_PROMPT = "0.000009"; // 9 USD/M
const CATALOG_BASE = "https://catalog.invalid";
const OPENROUTER_BASE = "https://openrouter.invalid/api/v1";
const SYNTHETIC_KEY = "synthetic-not-a-credential";

const legacy = (id: string): Model<"anthropic-messages"> => ({
	provider: "openrouter",
	id,
	name: "Synthetic legacy catalogue",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 1000,
	reasoning: false,
	cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
});

const baseProvider = (models: Model<"anthropic-messages">[]): Provider =>
	createProvider({
		id: "openrouter",
		models,
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

const liveEntry = (id: string) => ({
	id,
	context_length: 1000000,
	top_provider: { context_length: 1000000, max_completion_tokens: 128000 },
	pricing: {
		prompt: LIVE_PROMPT,
		completion: "0.000045",
		input_cache_read: "0.0000009",
		input_cache_write: "0.00001125",
	},
});

const usage = (input: number): Usage => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

let persisted: unknown;

beforeEach(() => {
	persisted = undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith(`${CATALOG_BASE}/api/models/providers/openrouter`)) return new Response(null, { status: 404 });
		if (url === `${OPENROUTER_BASE}/models/user`) {
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SYNTHETIC_KEY}`);
			return Response.json({ data: [liveEntry(FEED_ID), liveEntry(NOT_IN_FEED_ID)] });
		}
		throw new Error(`No network permitted: ${url}`);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

const personalizedBase = () =>
	withPersonalizedCatalog(
		baseProvider([legacy(FEED_ID), legacy(NOT_IN_FEED_ID)]),
		personalizeOpenRouterCatalog,
		CATALOG_BASE,
		1,
	);

async function personalizedProvider(): Promise<Provider> {
	const provider = personalizedBase();
	await provider.refreshModels?.({
		credential: { type: "api_key", key: SYNTHETIC_KEY },
		allowNetwork: true,
		baseUrl: OPENROUTER_BASE,
		signal: new AbortController().signal,
		publish: async (publication) => {
			if (publication.persist) persisted = publication.persist;
			publication.update?.();
			return true;
		},
	});
	return provider;
}
const byId = (provider: Provider, id: string) => provider.getModels().find((model) => model.id === id);

describe("live OpenRouter key prices", () => {
	it("survives the runtime projection for an id in the archived feed", async () => {
		const model = byId(await personalizedProvider(), FEED_ID);
		expect(model?.cost.input).toBe(9);
		// The live price is not the archived contract, so it is not certified.
		expect(model?.cost.assessment?.status).toBe("unknown");
	});

	it("is recorded into usage.cost by calculateCost", async () => {
		const model = byId(await personalizedProvider(), FEED_ID);
		if (!model) throw new Error("personalized model missing");
		// 1000 tokens, below the feed's 100000 threshold: live 0.009 USD vs archived 0.0001 USD.
		expect(calculateCost(model, usage(1000)).input).toBeCloseTo(0.009, 12);
	});

	it("is kept when the stored entry is restored offline", async () => {
		await personalizedProvider();
		expect(persisted).toBeDefined();
		const restarted = personalizedBase();
		await restarted.refreshModels?.({
			stored: persisted as never,
			allowNetwork: false,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		expect(byId(restarted, FEED_ID)?.cost.input).toBe(9);
		expect(byId(restarted, FEED_ID)?.cost.assessment?.status).toBe("unknown");
	});

	it("is kept for an id outside the feed, which stays unknown", async () => {
		const model = byId(await personalizedProvider(), NOT_IN_FEED_ID);
		expect(model?.cost.input).toBe(9);
		expect(model?.cost.assessment?.status).toBe("unknown");
		if (!model) throw new Error("personalized model missing");
		expect(calculateCost(model, usage(1000)).input).toBeCloseTo(0.009, 12);
		expect(estimateTokenCost(model, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }).cost).toBeNull();
	});

	it("does not stop stale built-in or pi.dev catalogue rows being corrected to the verified feed", () => {
		for (const provider of [
			withRemoteCatalog(baseProvider([legacy(FEED_ID)]), CATALOG_BASE, 1),
			withPersonalizedCatalog(baseProvider([legacy(FEED_ID)]), async (models) => models, CATALOG_BASE, 1),
		]) {
			const model = byId(provider, FEED_ID);
			expect(model?.cost.input).toBe(0.1);
			expect(model?.cost.assessment).toMatchObject({ status: "verified", checkedAt: "2026-11-13" });
		}
	});

	it("loses to a topmost models.json user override", async () => {
		const home = await mkdtemp(join(tmpdir(), "live-price-"));
		try {
			const path = join(home, "models.json");
			await writeFile(
				path,
				JSON.stringify({ providers: { openrouter: { modelOverrides: { [FEED_ID]: { cost: { input: 7 } } } } } }),
			);
			const composed = composeModelProvider(
				"openrouter",
				await personalizedProvider(),
				await ModelConfig.load(path),
				undefined,
			);
			expect(byId(composed, FEED_ID)?.cost).toMatchObject({ input: 7, assessment: { status: "unknown" } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("does not freeze a newer explicit assessment at the feed date", () => {
		const newer = {
			input: 3,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			assessment: {
				status: "verified" as const,
				checkedAt: "2026-12-01",
				source: "https://example.invalid/newer",
				unit: "usd-per-million-tokens" as const,
				conditions: "Synthetic newer assessment",
			},
		};
		expect(catalogueCost({ provider: "openrouter", id: FEED_ID, type: "chat", cost: newer })).toBe(newer);
	});
});
