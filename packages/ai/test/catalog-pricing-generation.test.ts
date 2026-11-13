import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// nredd/pi#46: both release output paths carry assessments without contacting a real catalog.
it("carries official corrections and explicit unknowns into bundled shards and public catalogs", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "pricing-generation-"));
	try {
		const isolated = join(root, "package");
		mkdirSync(isolated);
		for (const path of ["package.json", "src", "scripts"])
			cpSync(join(packageRoot, path), join(isolated, path), { recursive: true });
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (input) => {
			if (String(input) === 'https://models.dev/api.json') return Response.json({openai:{models:{'gpt-6.1-sol':{id:'gpt-6.1-sol',name:'Public Sol',tool_call:true,cost:{input:999,output:999}}}},'cloudflare-ai-gateway':{models:{'openai/gpt-4o':{id:'gpt-4o',name:'Public 4o',tool_call:true,cost:{input:999,output:999}},'openai/gpt-6.1-terra':{id:'gpt-6.1-terra',name:'Public Terra',tool_call:true,cost:{input:999,output:999}}}},'example-provider':{models:{}}});
			if (String(input).includes('models.dev/models.json')) return Response.json({'typesafe/jev-latest':{id:'jev-latest',type:'decision',name:'Public Jev'}});
			if (String(input).includes('openrouter.ai/api/v1/models')) return Response.json({data:[{id:'example/unknown',name:'Synthetic unknown',supported_parameters:['tools']}]});
			throw new Error('Offline synthetic source unavailable');
		};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preload).href,
				"scripts/generate-models.ts",
				"--json-output",
				join(root, "catalog"),
			],
			{ cwd: isolated, encoding: "utf8", timeout: 20000, env: { HOME: root, PATH: process.env.PATH } },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const legacy = JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"));
		const shard = JSON.parse(readFileSync(join(isolated, "src/providers/data/openai.json"), "utf8"));
		const cost = legacy.openai["gpt-6.1-sol"].cost;
		expect(cost).toMatchObject({
			input: 2,
			output: 10,
			cacheRead: 0.1,
			cacheWrite: 2.5,
			cacheWrite12h: 5,
			assessment: { status: "verified", checkedAt: "2026-11-12", unit: "usd-per-million-tokens" },
		});
		expect(shard["openai-responses"]["chat:gpt-6.1-sol"].cost).toEqual(cost);
		expect(legacy["cloudflare-ai-gateway"]["gpt-4o"].cost.input).toBe(2.5);
		expect(legacy["cloudflare-ai-gateway"]["gpt-4o"].cost.tiers).toBeUndefined();
		expect(legacy["cloudflare-ai-gateway"]["gpt-6.1-terra"].cost.tiers).toEqual([
			{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
		]);
		expect(legacy.openrouter["example/unknown"].cost.assessment.status).toBe("unknown");
		const classifiers = JSON.parse(readFileSync(join(root, "catalog/models.all.json"), "utf8"));
		expect(
			classifiers.typesafe.find((model: { type: string }) => model.type === "classifier").cost.assessment.status,
		).toBe("unknown");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
