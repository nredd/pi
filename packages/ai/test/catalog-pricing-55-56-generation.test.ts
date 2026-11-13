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
			pricing: prices.openrouter[id as keyof typeof prices.openrouter].pricing,
		}));
		const gateway = ["alibaba/qwen-3-14b", "openai/gpt-6.1-sol"].map((id) => ({
			id,
			name: id,
			type: "language",
			tags: ["tool-use"],
			pricing: prices["vercel-ai-gateway"][id as keyof (typeof prices)["vercel-ai-gateway"]].pricing,
		}));
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === 'https://models.dev/api.json') return Response.json({});
			if (url.includes('models.dev/models.json')) return Response.json({'typesafe/jev-latest':{id:'jev-latest',type:'decision',name:'Public Jev'}});
			if (url.includes('openrouter.ai/api/v1/models')) return Response.json({data:${JSON.stringify(router)}});
			if (url === 'https://ai-gateway.vercel.sh/v1/models') return Response.json({data:${JSON.stringify(gateway)}});
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
		expect(JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"))).toEqual(legacy);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
