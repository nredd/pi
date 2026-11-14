import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = new URL("../src/models.ts", import.meta.url).href;
const distEntry = fileURLToPath(new URL("../dist/models.js", import.meta.url));
const specifierEntry = "@earendil-works/pi-ai/models";
const distBuilt = existsSync(distEntry);
// The specifier case must resolve through `exports["./models"].import` (dist), so it runs without
// `--conditions=source`. Local runs after only `npm run worktree:setup` have no dist, so skip there;
// CI always builds first and must fail, never skip, when dist is missing.
const skipSpecifier = !distBuilt && !process.env.CI;

// Install before linking the static imports, so unused barrel re-exports are checked too.
const preload = `data:text/javascript,${encodeURIComponent(`
	import { registerHooks } from "node:module";
	const forbidden = [
		"/node_modules/typebox/",
		"/node_modules/@anthropic-ai/sdk/",
		"/node_modules/openai/",
		"/node_modules/@google/genai/",
		"/node_modules/@aws-sdk/",
		"/providers/data/",
		"/models.generated.",
	];
	registerHooks({
		load(url, context, nextLoad) {
			if (forbidden.some((part) => url.includes(part))) {
				throw new Error("Heavy dependency loaded by models entry: " + url);
			}
			return nextLoad(url, context);
		},
	});
`)}`;

describe("lightweight models entry", () => {
	for (const { entry, conditions, skip } of [
		{ entry: sourceEntry, conditions: ["--conditions=source"], skip: false },
		{ entry: specifierEntry, conditions: [] as string[], skip: skipSpecifier },
	]) {
		it.skipIf(skip)(`runs a faux completion without TypeBox, catalogs, or SDKs through ${entry}`, () => {
			if (entry === specifierEntry) expect(distBuilt, "packages/ai/dist/models.js missing").toBe(true);
			const script = `
				import assert from "node:assert/strict";
				import { createModels, createProvider } from ${JSON.stringify(entry)};
				import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
				assert.equal(typeof createProvider, "function");
				const models = createModels();
				assert.deepEqual(models.getModels(), []);
				assert.deepEqual(models.getProviders(), []);
				const faux = fauxProvider();
				models.setProvider(faux.provider);
				faux.setResponses([fauxAssistantMessage("OK")]);
				const response = await models.completeSimple(faux.getModel(), { messages: [] });
				assert.equal(response.stopReason, "stop");
				assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
			`;
			const result = spawnSync(
				process.execPath,
				[...conditions, "--import", preload, "--input-type=module", "--eval", script],
				{
					cwd: packageRoot,
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
		});
	}
});
