import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// nredd/pi#57 and #58: generation and hydration use the same exact-ID corrections.
it("hydrates Bedrock assessments from synthetic catalogue input", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "bedrock-pricing-"));
	try {
		const isolated = join(root, "package");
		mkdirSync(isolated);
		for (const path of ["package.json", "src", "scripts"])
			cpSync(join(packageRoot, path), join(isolated, path), { recursive: true });
		const preload = join(root, "offline.mjs");
		writeFileSync(
			preload,
			`globalThis.fetch = async (url) => {
			if (String(url) === 'https://models.dev/api.json') return Response.json({'amazon-bedrock':{models:{'amazon.nova-lite-v1:0':{id:'amazon.nova-lite-v1:0',name:'Nova',tool_call:true,cost:{input:999,output:999}},'openai.gpt-6.1-terra':{id:'openai.gpt-6.1-terra',name:'Terra',tool_call:true,cost:{input:999,output:999}}}}});
			if (String(url).includes('models.dev/models.json')) return Response.json({});
			if (String(url).includes('openrouter.ai/api/v1/models')) return Response.json({data:[]});
			throw new Error('Offline synthetic source unavailable');
		};\n`,
		);
		for (const args of [["--json-output", join(root, "catalog")], ["--data-only"]]) {
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
			const shard = JSON.parse(readFileSync(join(isolated, "src/providers/data/amazon-bedrock.json"), "utf8"));
			expect(shard["bedrock-converse-stream"]["chat:amazon.nova-lite-v1:0"].cost).toMatchObject({
				input: 0.06,
				cacheRead: 0.015,
				assessment: { unavailable: ["cacheWrite"] },
			});
			expect(shard["bedrock-converse-stream"]["chat:openai.gpt-6.1-terra"].cost).toMatchObject({
				input: 1,
				output: 5,
				assessment: { unavailable: ["cacheWrite"] },
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
