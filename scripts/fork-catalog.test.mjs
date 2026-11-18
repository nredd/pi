import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createModelDataManifest,
	readModelDataStructure,
	validateGeneratedModelData,
} from "../packages/ai/scripts/model-data.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const built = existsSync(join(root, "packages/coding-agent/dist/bundle/index.js"));
const scratch = mkdtempSync(join(tmpdir(), "pi-fork-catalog-"));

before(() => {
	if (!built) return;
	for (const pkg of ["ai", "coding-agent"]) {
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
				cwd: join(root, "packages", pkg),
				encoding: "utf8",
			}),
		);
		const target = join(scratch, pkg);
		mkdirSync(target);
		execFileSync("tar", ["-xzf", join(scratch, packed[0].filename), "-C", target]);
	}
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// nredd/pi#122: frozen data is not a license to refresh unrelated providers or bless corrupt hashes.
test("offline fork overlay is deterministic, scoped and rejects corrupt frozen input", () => {
	const isolated = join(scratch, "isolated");
	mkdirSync(isolated);
	for (const entry of ["src", "scripts", "package.json"])
		cpSync(join(root, "packages/ai", entry), join(isolated, entry), { recursive: true });
	const dataDir = join(isolated, "src/providers/data");
	const files = Object.fromEntries(
		readdirSync(dataDir)
			.filter((name) => name !== ".manifest.json")
			.map((name) => [name, readFileSync(join(dataDir, name), "utf8")]),
	);
	const original = structuredClone(files);
	for (const provider of ["openai", "openai-codex"]) {
		const groups = JSON.parse(files[`${provider}.json`]);
		for (const models of Object.values(groups))
			for (const id of ["gpt-6.2-sol", "gpt-6.2-astra"]) delete models[`chat:${id}`];
		files[`${provider}.json`] = `${JSON.stringify(groups)}\n`;
		writeFileSync(join(dataDir, `${provider}.json`), files[`${provider}.json`]);
	}
	const manifest = JSON.parse(readFileSync(join(dataDir, ".manifest.json"), "utf8"));
	writeFileSync(
		join(dataDir, ".manifest.json"),
		JSON.stringify(createModelDataManifest(readModelDataStructure(isolated), files, manifest.generatedAt)),
	);
	const apply = () =>
		execFileSync(process.execPath, [join(isolated, "scripts/apply-fork-models.ts")], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: scratch },
		});
	apply();
	validateGeneratedModelData(isolated);
	const first = Object.fromEntries(
		readdirSync(dataDir).map((name) => [name, readFileSync(join(dataDir, name), "utf8")]),
	);
	for (const [name, content] of Object.entries(original)) {
		if (!["openai.json", "openai-codex.json"].includes(name)) assert.equal(first[name], content);
		else {
			const models = JSON.parse(first[name]);
			for (const group of Object.values(models))
				for (const id of ["gpt-6.2-sol", "gpt-6.2-astra"]) delete group[`chat:${id}`];
			assert.deepEqual(models, JSON.parse(files[name]));
		}
	}
	assert.equal(JSON.parse(first[".manifest.json"]).generatedAt, manifest.generatedAt);
	apply();
	for (const [name, content] of Object.entries(first))
		assert.equal(readFileSync(join(dataDir, name), "utf8"), content);
	writeFileSync(join(dataDir, "openai.json"), `${first["openai.json"]} `);
	assert.throws(apply, /does not match its manifest hash/);
	assert.equal(readFileSync(join(dataDir, "openai.json"), "utf8"), `${first["openai.json"]} `);
	assert.equal(readFileSync(join(dataDir, ".manifest.json"), "utf8"), first[".manifest.json"]);
});

function checkModels(getModel) {
	for (const [id, input, output, cacheRead, cacheWrite, cacheWrite12h] of [
		["gpt-6.2-sol", 2, 10, 0.1, 2.5, 5],
		["gpt-6.2-astra", 8, 40, 0.4, 10, 20],
	]) {
		assert.equal(getModel("azure", id), undefined, `Azure must not advertise ${id}`);
		for (const provider of ["openai", "openai-codex"]) {
			const model = getModel(provider, id);
			assert.ok(model, `${provider}/${id} missing from packed catalog`);
			assert.equal(model.type, "chat");
			assert.equal(model.provider, provider);
			assert.equal(model.id, id);
			assert.equal(model.api, provider === "openai" ? "openai-responses" : "openai-codex-responses");
			assert.equal(model.contextWindow, 272000);
			assert.equal(model.maxTokens, 128000);
			assert.equal(model.reasoning, true);
			assert.deepEqual(model.input, ["text", "image"]);
			assert.deepEqual(model.thinkingLevelMap, {
				off: null,
				minimal: provider === "openai-codex" ? "low" : null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
			for (const [key, rate] of Object.entries({ input, output, cacheRead, cacheWrite, cacheWrite12h }))
				assert.equal(model.cost[key], rate);
			assert.equal(model.cost.assessment.status, "unknown");
			assert.match(model.cost.assessment.reason, /2026-11-17/);
			assert.equal(model.cost.assessment.checkedAt, undefined);
			assert.deepEqual(model.cost.tiers, [
				{
					inputTokensAbove: 272000,
					input: input * 2,
					output: output * 1.5,
					cacheRead: cacheRead * 2,
					cacheWrite: cacheWrite * 2,
					cacheWrite12h: cacheWrite12h * 2,
				},
			]);
			assert.notEqual(model.compat?.supportsMidConvoEffort, true);
			assert.notEqual(model.compat?.supportsMidConvoSystemMessages, true);
			if (provider === "openai") {
				assert.equal(model.inputLimits.maxInputTokens, 922000);
				assert.equal(model.compat.supportsToolSearch, true);
				assert.equal(model.compat.supportsAdditionalTools, true);
			} else {
				assert.notEqual(model.compat?.supportsToolSearch, true);
				assert.notEqual(model.compat?.supportsAdditionalTools, true);
			}
		}
	}
}

// nredd/pi#122: assert shipped bytes, not generator-only output or a source import.
test(
	"packed pi-ai contains the fork additions with conservative contracts",
	{ skip: !built && !process.env.CI },
	() => {
		assert.ok(built, "Run npm run build:offline first");
		const shards = Object.fromEntries(
			["openai", "openai-codex", "azure"].map((provider) => [
				provider,
				JSON.parse(readFileSync(join(scratch, "ai/package/dist/providers/data", `${provider}.json`), "utf8")),
			]),
		);
		checkModels((provider, id) =>
			Object.values(shards[provider])
				.flatMap(Object.values)
				.find((model) => model.id === id),
		);
	},
);

test(
	"packed coding-agent bundle exposes the fork additions without catalog refresh",
	{ skip: !built && !process.env.CI },
	() => {
		assert.ok(built, "Run npm run build:offline first");
		const probe = join(scratch, "probe.mjs");
		writeFileSync(
			probe,
			`import { ModelRuntime } from './coding-agent/package/dist/bundle/index.js';
const runtime = await ModelRuntime.create({authPath: ${JSON.stringify(join(scratch, "auth.json"))}, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false});
console.log(JSON.stringify(runtime.getModels().filter(model => ['openai','openai-codex','azure'].includes(model.provider))));\n`,
		);
		const models = JSON.parse(
			execFileSync(process.execPath, [probe], {
				cwd: scratch,
				encoding: "utf8",
				env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: scratch, PI_NO_LOCAL_LLM: "1" },
				timeout: 30000,
			}),
		);
		checkModels((provider, id) => models.find((model) => model.provider === provider && model.id === id));
	},
);
