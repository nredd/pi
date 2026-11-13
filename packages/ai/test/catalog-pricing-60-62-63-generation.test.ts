import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// nredd/pi#60, #62, #63: both generator paths receive the same exact assessments.
it("hydrates exact family assessments into shards and JSON", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "pricing-families-"));
	try {
		const isolated = join(root, "package");
		mkdirSync(isolated);
		for (const path of ["package.json", "src", "scripts"])
			cpSync(join(packageRoot, path), join(isolated, path), { recursive: true });
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (url) => {
			if (String(url) === 'https://models.dev/api.json') return Response.json({
				cerebras: {models: {'gpt-oss-120b': {id:'gpt-oss-120b',tool_call:true,cost:{input:999,output:999}}}},
				xai: {models: {'grok-4.7': {id:'grok-4.7',tool_call:true,cost:{input:999,output:999}}}},
				google: {models: {'gemini-3.5-flash-lite': {id:'gemini-3.5-flash-lite',tool_call:true,cost:{input:999,output:999}}}}
			});
			if (String(url).includes('models.dev/models.json')) return Response.json({});
			if (String(url).includes('openrouter.ai/api/v1/models')) return Response.json({data:[]});
			throw new Error('Offline synthetic source unavailable');
		};`,
		);
		const run = (args: string[]) =>
			spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", ...args], {
				cwd: isolated,
				encoding: "utf8",
				timeout: 20000,
				env: { HOME: root, PATH: process.env.PATH },
			});
		const result = run(["--json-output", join(root, "catalog")]);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const legacy = JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"));
		for (const [provider, api, id, input] of [
			["cerebras", "openai-completions", "gpt-oss-120b", 0.35],
			["xai", "openai-responses", "grok-4.7", 2],
			["google", "google-generative-ai", "gemini-3.5-flash-lite", 0.3],
		] as const) {
			const cost = legacy[provider][id].cost;
			expect(cost).toMatchObject({ input, assessment: { status: "verified", unavailable: ["cacheWrite"] } });
			const shard = JSON.parse(readFileSync(join(isolated, `src/providers/data/${provider}.json`), "utf8"));
			expect(shard[api][`chat:${id}`].cost).toEqual(cost);
		}
		const hydrated = run(["--data-only"]);
		expect(hydrated.status, `${hydrated.stdout}\n${hydrated.stderr}`).toBe(0);
		const shard = JSON.parse(readFileSync(join(isolated, "src/providers/data/xai.json"), "utf8"));
		expect(shard["openai-responses"]["chat:grok-4.7"].cost).toEqual(legacy.xai["grok-4.7"].cost);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
