import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionServices } from "../../dist/bundle/index.js";
import { ExtensionStartupError } from "../../dist/index.js";
import { loadExtensions, loadExtensionsCached } from "../../dist/core/extensions/loader.js";
import { createHarness, fauxAssistantMessage } from "../../dist/testing/index.js";
import { createInteractiveHarness } from "../../dist/testing/interactive.js";

// nredd/pi#51: real compiled SDK, bundled services, faux transport, and virtual terminal only.
globalThis.fetch = () => { throw new Error("network forbidden"); };
const cwd = process.cwd();
const agentDir = join(cwd, "agent");
mkdirSync(agentDir);
const extensionPath = join(cwd, "extension.mjs");
writeFileSync(extensionPath, 'export default function (pi) { pi.registerCommand("probe", { handler: async () => {} }); }');
const services = await createAgentSessionServices({
	cwd, agentDir,
	resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [extensionPath] },
	resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
});
assert.equal(services.diagnostics.length, 0);
await services.resourceLoader.reload();
await loadExtensionsCached([extensionPath], cwd);
await loadExtensionsCached([extensionPath], cwd);
const factoryFailure = join(cwd, "factory-failure.mjs");
const importFailure = join(cwd, "import-failure.mjs");
writeFileSync(factoryFailure, 'export default function () { throw new Error("private factory detail"); }');
assert.equal((await loadExtensions([factoryFailure], cwd)).errors.length, 1);
writeFileSync(importFailure, "export default ???");
assert.equal((await loadExtensions([importFailure], cwd)).errors.length, 1);
await createAgentSessionServices({ cwd, agentDir, modelRuntime: services.modelRuntime, resourceLoaderOptions: { noExtensions: true } });

let fatal = false;
let hold = false;
const entered = [];
const releases = [];
const harness = await createHarness({ useModelRuntimeStream: true, extensionFactories: [(pi) => {
	pi.on("session_start", async () => {
		if (fatal) throw new ExtensionStartupError("private fatal detail");
		if (hold) await new Promise((resolve) => { entered.push(true); releases.push(resolve); });
	});
	pi.registerCommand("probe", { handler: async () => {} });
}] });
try {
	hold = true;
	const first = harness.session.bindExtensions({ mode: "print" });
	const second = harness.session.bindExtensions({ mode: "print" });
	while (entered.length < 2) await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(harness.session.prompt("private prompt"), /starting/);
	assert.equal(harness.faux.state.callCount, 0);
	for (const resolve of releases) resolve();
	await Promise.all([first, second]);
	hold = false;
	await harness.session.prompt("/probe private arguments");
	fatal = true;
	await assert.rejects(harness.session.bindExtensions({ mode: "print" }));
	await assert.rejects(harness.session.prompt("private prompt"));
	assert.equal(harness.faux.state.callCount, 0);
	fatal = false;
	await harness.session.reload();
	harness.setResponses([fauxAssistantMessage("synthetic response")]);
	await harness.session.prompt("synthetic input");
	assert.equal(harness.faux.state.callCount, 1);
} finally { harness.cleanup(); }
for (const tuiMode of ["regular", "fullscreen"]) {
	const host = await createInteractiveHarness({ tuiMode, extensionFactories: [(pi) => { pi.registerCommand("probe", { handler: async () => {} }); }] });
	try { await host.settle(); await host.harness.session.prompt("/probe"); }
	finally { await host.dispose(); }
}
