import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import prices from "../src/catalog-feed-prices.json" with { type: "json" };

// nredd/pi#55/#56: actual raw-shaped feeds exercise both public generation and release hydration.
it("retains exact feed assessments and unavailable categories through both generator modes", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "feed-pricing-generation-"));
	try {
		const isolated = join(root, "package");
		mkdirSync(isolated);
		for (const path of ["package.json", "src", "scripts"])
			cpSync(join(packageRoot, path), join(isolated, path), { recursive: true });
		const router = ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-4.5"].map((id) => ({
			id,
			name: id,
			supported_parameters: ["tools"],
			pricing: prices.openrouter[`chat:${id}` as keyof typeof prices.openrouter].pricing,
		}));
		const gateway = ["alibaba/qwen-3-14b", "openai/gpt-6.1-sol"].map((id) => ({
			id,
			name: id,
			type: "language",
			tags: ["tool-use"],
			pricing: prices["vercel-ai-gateway"][`chat:${id}` as keyof (typeof prices)["vercel-ai-gateway"]].pricing,
		}));
		const routerClassifier = {
			id: "cloudflare/clef",
			name: "Public Clef",
			architecture: { output_modalities: ["decisions"] },
			pricing: prices.openrouter["classifier:cloudflare/clef"].pricing,
		};
		const gatewayClassifier = {
			id: "convaiinnovations/laya",
			name: "Public Laya",
			type: "evaluation",
			pricing: prices["vercel-ai-gateway"]["classifier:convaiinnovations/laya"].pricing,
		};
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === 'https://models.dev/api.json') return Response.json({});
			if (url.includes('models.dev/models.json')) return Response.json({'typesafe/jev-latest':{id:'jev-latest',type:'decision',name:'Public Jev'}});
			if (url.includes('openrouter.ai/api/v1/models?output_modalities=decisions')) return Response.json({data:${JSON.stringify([routerClassifier])}});
			if (url.includes('openrouter.ai/api/v1/models')) return Response.json({data:${JSON.stringify(router)}});
			if (url === 'https://ai-gateway.vercel.sh/v1/models') return Response.json({data:${JSON.stringify([...gateway, gatewayClassifier])}});
			throw new Error('Offline synthetic input only');
		};`,
		);
		const run = (args: string[]) => {
			const result = spawnSync(
				process.execPath,
				["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", ...args],
				{
					cwd: isolated,
					encoding: "utf8",
					timeout: 20000,
					env: { HOME: root, PATH: process.env.PATH, PI_OFFLINE: "1" },
				},
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		};
		run(["--json-output", join(root, "catalog")]);
		const legacy = JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"));
		const all = JSON.parse(readFileSync(join(root, "catalog/models.all.json"), "utf8"));
		for (const [provider, id, rate] of [
			["openrouter", routerClassifier.id, 0.192],
			["vercel-ai-gateway", gatewayClassifier.id, 0.0105],
		] as const) {
			const classifier = all[provider].find(
				(model: { id: string; type: string }) => model.id === id && model.type === "classifier",
			);
			expect(classifier.cost).toMatchObject({
				input: rate,
				assessment: { status: "verified", unavailable: ["cacheRead", "cacheWrite"] },
			});
		}

		for (const [provider, ids] of [
			["openrouter", router.map((model) => model.id)],
			["vercel-ai-gateway", gateway.map((model) => model.id)],
		] as const) {
			const shard = JSON.parse(readFileSync(join(isolated, `src/providers/data/${provider}.json`), "utf8"));
			for (const id of ids) {
				const cost = legacy[provider][id].cost;
				expect(cost.assessment).toMatchObject({ status: "verified", checkedAt: "2026-11-13" });
				expect(
					Object.values(shard)
						.flatMap((group) => Object.values(group as Record<string, { cost: unknown }>))
						.find((model) => JSON.stringify(model.cost) === JSON.stringify(cost)),
				).toBeDefined();
			}
		}
		expect(legacy["vercel-ai-gateway"]["alibaba/qwen-3-14b"].cost.assessment.unavailable).toEqual([
			"cacheRead",
			"cacheWrite",
		]);
		expect(legacy["vercel-ai-gateway"]["openai/gpt-6.1-sol"].cost.tiers[0].inputTokensAbove).toBe(272000);
		run(["--data-only"]);
		for (const [provider, ids] of [
			["openrouter", router.map((model) => model.id)],
			["vercel-ai-gateway", gateway.map((model) => model.id)],
		] as const) {
			const shard = JSON.parse(readFileSync(join(isolated, `src/providers/data/${provider}.json`), "utf8"));
			const models = Object.values(shard).flatMap((group) =>
				Object.values(group as Record<string, { id: string; cost: unknown }>),
			);
			for (const id of ids) expect(models.find((model) => model.id === id)?.cost).toEqual(legacy[provider][id].cost);
		}
		for (const [provider, id] of [
			["openrouter", routerClassifier.id],
			["vercel-ai-gateway", gatewayClassifier.id],
		] as const) {
			const shard = JSON.parse(readFileSync(join(isolated, `src/providers/data/${provider}.json`), "utf8"));
			const actual = shard["typesafe-system-one"][`classifier:${id}`];
			expect(actual.cost).toEqual(all[provider].find((model: { id: string }) => model.id === id).cost);
		}
		expect(JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"))).toEqual(legacy);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
