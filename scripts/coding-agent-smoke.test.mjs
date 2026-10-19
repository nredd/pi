import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
}

function createFixture(t, { importUndeclared = false, exportTesting = true, renderFrame = true, exportTerminal = true } = {}) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", codingAgentName.split("/")[1]),
		{
			name: codingAgentName,
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				...(exportTesting ? { "./testing": { types: "./dist/index.d.ts", import: "./dist/testing/index.js" } } : {}),
			},
			files: ["dist"],
			bin: { pi: "dist/bundle/cli.js" },
			dependencies: { "@earendil-works/pi-tui": "1.0.0" },
		},
		{
			"dist/index.js": `${importUndeclared ? 'import "@earendil-works/undeclared";' : ""}
export function createAgentSession() {}
export class SessionManager { static inMemory() {} }
export class ModelRuntime { static create() {} }
`,
			"dist/index.d.ts": "export {};\n",
			"dist/testing/index.js": `export const fauxAssistantMessage = (text) => ({ role: "assistant", text });
export const getAssistantTexts = (harness) => harness.texts;
export async function createHarness() {
	const harness = { texts: [], responses: [], cleanup() {} };
	harness.setResponses = (responses) => { harness.responses = responses; };
	harness.session = { prompt: async () => { harness.texts.push(harness.responses.shift().text); } };
	return harness;
}
export async function createInteractiveHarness() {
	return {
		harness: await createHarness(),
		async settle() {},
		viewport: () => ${renderFrame ? '["PACKED INTERACTIVE FRAME"]' : '[]'},
		async dispose() {},
	};
}
`,
			"dist/cli.js": 'console.log("1.0.0");\n',
			"dist/bundle/cli.js": 'console.log("1.0.0");\n',
		},
	);
	writePackage(join(repoRoot, "packages", "pi-tui"), {
		name: "@earendil-works/pi-tui", version: "1.0.0", type: "module", main: "./dist/index.js", types: "./dist/index.d.ts",
		exports: { ".": "./dist/index.js", ...(exportTerminal ? { "./testing": "./dist/testing.js" } : {}) }, files: ["dist"],
	}, {
		"dist/index.js": "export {};\n", "dist/index.d.ts": "export {};\n",
		"dist/testing.js": "export class VirtualTerminal { dispose() {} }\n",
	});
	const artifactSet = produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null });
	const directory = join(root, "consumer");
	installConsumer({ artifactSet, directory, packageNames: [codingAgentName] });
	return directory;
}

test("accepts a valid coding-agent package", (t) => {
	smokeTestCodingAgent(createFixture(t), process.execPath, { checkCli: false });
});

// #9132: smoke-test the public SDK, not just a bundled CLI that hides missing imports.
test("fails when the SDK imports an undeclared package despite a working CLI", (t) => {
	const directory = createFixture(t, { importUndeclared: true });
	assert.throws(() => smokeTestCodingAgent(directory, process.execPath, { checkCli: false }), /Cannot find package '@earendil-works\/undeclared'/);
});

test("fails when the interactive host renders no frame", (t) => {
	assert.throws(() => smokeTestCodingAgent(createFixture(t, { renderFrame: false }), process.execPath, { checkCli: false }), /AssertionError/);
});

test("fails when the terminal testing entry is not exported", (t) => {
	assert.throws(() => smokeTestCodingAgent(createFixture(t, { exportTerminal: false }), process.execPath, { checkCli: false }), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("fails when the in-process testing entry is not exported", (t) => {
	const directory = createFixture(t, { exportTesting: false });
	assert.throws(() => smokeTestCodingAgent(directory, process.execPath, { checkCli: false }), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});
