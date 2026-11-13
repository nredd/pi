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
			if (String(input) === 'https://models.dev/api.json') return Response.json({anthropic:{models:{'claude-sonnet-4-5':{id:'claude-sonnet-4-5',name:'Public Sonnet',tool_call:true,cost:{input:999,output:999}}}},openai:{models:{'gpt-6.1-sol':{id:'gpt-6.1-sol',name:'Public Sol',tool_call:true,cost:{input:999,output:999}}}},'cloudflare-ai-gateway':{models:{'openai/gpt-4o':{id:'gpt-4o',name:'Public 4o',tool_call:true,cost:{input:999,output:999}},'openai/gpt-6.1-terra':{id:'gpt-6.1-terra',name:'Public Terra',tool_call:true,cost:{input:999,output:999}}}},'example-provider':{models:{}},'amazon-bedrock':{models:{'amazon.nova-lite-v1:0':{id:'amazon.nova-lite-v1:0',name:'Nova',tool_call:true,cost:{input:999,output:999}},'openai.gpt-6.1-terra':{id:'openai.gpt-6.1-terra',name:'Terra',tool_call:true,cost:{input:999,output:999}}}}});
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
		// nredd/pi#57 and #58: both Bedrock contracts reach generated and hydrated output.
		const bedrock = legacy["amazon-bedrock"];
		for (const [id, input, read, output, unavailable] of [
			["amazon.nova-lite-v1:0", 0.06, 0.015, 0.24, ["cacheWrite"]],
			["openai.gpt-6.1-terra", 1, 0.05, 5, []],
		] as const) {
			expect(structuredClone(bedrock[id].cost)).toMatchObject({
				input,
				cacheRead: read,
				output,
				assessment: { unavailable },
			});
			const data = JSON.parse(readFileSync(join(isolated, "src/providers/data/amazon-bedrock.json"), "utf8"));
			expect(data["bedrock-converse-stream"][`chat:${id}`].cost).toEqual(bedrock[id].cost);
		}
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
		// nredd/pi#53: the public and bundled routes retain the bounded legacy contract.
		const claude = legacy.anthropic["claude-sonnet-4-5"].cost;
		expect(claude).toMatchObject({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
			cacheWrite1h: 6,
			assessment: { status: "verified", maxContextTokens: 200000, maxOutputTokens: 64000, retiredOn: "2026-11-30" },
		});
		const anthropic = JSON.parse(readFileSync(join(isolated, "src/providers/data/anthropic.json"), "utf8"));
		expect(anthropic["anthropic-messages"]["chat:claude-sonnet-4-5"].cost).toEqual(claude);
		// nredd/pi#52: the same exact Codex selector survives both release output paths.
		const terra = legacy["openai-codex"]["gpt-6.1-terra"];
		expect(terra).toMatchObject({
			id: "gpt-6.1-terra",
			api: "openai-codex-responses",
			contextWindow: 272000,
			cost: {
				input: 1,
				output: 5,
				cacheRead: 0.05,
				cacheWrite: 1.25,
				cacheWrite12h: 2.5,
				assessment: { status: "verified", checkedAt: "2026-11-13" },
				tiers: [
					{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite12h: 5 },
				],
			},
		});
		const codexShard = JSON.parse(readFileSync(join(isolated, "src/providers/data/openai-codex.json"), "utf8"));
		expect(codexShard["openai-codex-responses"]["chat:gpt-6.1-terra"].cost).toEqual(terra.cost);
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
		// nredd/pi#46: release hydration is a separate mode, with no public JSON output.
		const hydrated = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", "--data-only"],
			{ cwd: isolated, encoding: "utf8", timeout: 20000, env: { HOME: root, PATH: process.env.PATH } },
		);
		expect(hydrated.status, `${hydrated.stdout}\n${hydrated.stderr}`).toBe(0);
		const hydratedShard = JSON.parse(readFileSync(join(isolated, "src/providers/data/openai.json"), "utf8"));
		expect(hydratedShard["openai-responses"]["chat:gpt-6.1-sol"].cost).toEqual(cost);
		const hydratedAnthropic = JSON.parse(readFileSync(join(isolated, "src/providers/data/anthropic.json"), "utf8"));
		expect(hydratedAnthropic["anthropic-messages"]["chat:claude-sonnet-4-5"].cost).toEqual(claude);
		const hydratedBedrock = JSON.parse(
			readFileSync(join(isolated, "src/providers/data/amazon-bedrock.json"), "utf8"),
		);
		for (const id of ["amazon.nova-lite-v1:0", "openai.gpt-6.1-terra"])
			expect(hydratedBedrock["bedrock-converse-stream"][`chat:${id}`].cost).toEqual(bedrock[id].cost);
		const hydratedCodex = JSON.parse(readFileSync(join(isolated, "src/providers/data/openai-codex.json"), "utf8"));
		expect(hydratedCodex["openai-codex-responses"]["chat:gpt-6.1-terra"].cost).toEqual(terra.cost);
		expect(JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"))).toEqual(legacy);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
