import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// nredd/pi#64 and #66: generation and hydration use the same exact broker mappings.
it("hydrates broker rates without a live catalogue", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "broker-generation-"));
	try {
		const isolated = join(root, "package");
		mkdirSync(isolated);
		for (const path of ["package.json", "src", "scripts"])
			cpSync(join(packageRoot, path), join(isolated, path), { recursive: true });
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === 'https://models.dev/api.json') return Response.json({opencode:{models:{'claude-haiku-4-5':{id:'claude-haiku-4-5',name:'Synthetic Haiku',tool_call:true,cost:{input:999,output:999}}}}});
			if (url === 'https://radius.pi.dev/v1/config') return Response.json({baseUrl:'https://radius.invalid',models:[{id:'claude-haiku-5-5',name:'Synthetic Haiku',reasoning:false,input:['text'],cost:{input:999,output:999,cacheRead:999,cacheWrite:999},contextWindow:200000,maxTokens:1000}]});
			if (url.includes('models.dev/models.json')) return Response.json({});
			if (url.includes('openrouter.ai/api/v1/models')) return Response.json({data:[]});
			throw new Error('Offline synthetic source unavailable');
		};\n`,
		);
		const run = (args: string[]) => {
			const result = spawnSync(
				process.execPath,
				["--import", pathToFileURL(preload).href, "scripts/generate-models.ts", ...args],
				{
					cwd: isolated,
					encoding: "utf8",
					timeout: 20000,
					env: { HOME: root, PATH: process.env.PATH },
				},
			);
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		};
		run(["--json-output", join(root, "catalog")]);
		const catalog = JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8"));
		const radius = catalog.radius["claude-haiku-5-5"].cost;
		const opencode = catalog.opencode["claude-haiku-4-5"].cost;
		expect(radius).toMatchObject({
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			assessment: { checkedAt: "2026-11-13", unavailable: ["cacheWrite"] },
		});
		expect(opencode).toMatchObject({
			input: 1,
			output: 5,
			cacheRead: 0.1,
			assessment: { checkedAt: "2026-11-13", unavailable: ["cacheWrite"] },
		});
		run(["--data-only"]);
		for (const [provider, id, expected] of [
			["radius", "claude-haiku-5-5", radius],
			["opencode", "claude-haiku-4-5", opencode],
		] as const) {
			const shard = JSON.parse(readFileSync(join(isolated, `src/providers/data/${provider}.json`), "utf8"));
			const model = Object.values(shard)
				.flatMap((group) => Object.values(group as Record<string, { id: string; cost: unknown }>))
				.find((model) => model.id === id);
			expect(model?.cost).toEqual(expected);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
