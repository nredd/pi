import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exerciseMemory, installMemory, isolatedEnvironment, run } from "./smoke-test-memory-binary.mjs";

// nredd/pi#43: a marker-printing stand-in cannot satisfy the real tool/API exchange.
test("refuses a marker-only child and preserves actual extension startup errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-contract-"));
	try {
		const child = join(root, "fixture.js"),
			env = isolatedEnvironment(root);
		await writeFile(child, 'console.log("PI_MEMORY_BINARY_SMOKE_OK");');
		await assert.rejects(exerciseMemory(child, "absent-memory.ts", root, env), /Memory smoke failed \(0 requests\)/);
		await writeFile(child, 'console.error("Type3 is not defined"); process.exitCode = 1;');
		await assert.rejects(exerciseMemory(child, "absent-memory.ts", root, env), /Type3 is not defined/);
		await writeFile(child, 'process.stdout.write("x".repeat(2 * 1024 * 1024));');
		await assert.rejects(run(process.execPath, [child], root, env), /output limit/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("refuses registry errors and wrong SRI before extracting a memory package", async () => {
	const original = globalThis.fetch,
		root = await mkdtemp(join(tmpdir(), "pi-memory-integrity-"));
	try {
		globalThis.fetch = async () => new Response("bad", { status: 503 });
		await assert.rejects(installMemory(root, isolatedEnvironment(root)), /HTTP 503/);
		globalThis.fetch = async () => new Response("wrong bytes");
		await assert.rejects(installMemory(root, isolatedEnvironment(root)), /integrity mismatch/);
	} finally {
		globalThis.fetch = original;
		await rm(root, { recursive: true, force: true });
	}
});
test("forwards no user credential or provider configuration to Pi", () => {
	const env = isolatedEnvironment("/synthetic");
	const allowed = new Set([
		"PATH",
		"Path",
		"SystemRoot",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"WINDIR",
		"HOME",
		"USERPROFILE",
		"TMPDIR",
		"TMP",
		"TEMP",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"PI_CODING_AGENT_DIR",
		"PI_MEMORY_DIR",
		"PI_MEMORY_EXIT_SUMMARY",
		"PI_MEMORY_NO_SEARCH",
		"PI_OFFLINE",
		"npm_config_userconfig",
		"npm_config_globalconfig",
		"npm_config_cache",
	]);
	assert.ok(Object.keys(env).every((key) => allowed.has(key)));
	assert.equal(env.HOME, "/synthetic");
	assert.equal(env.PI_MEMORY_EXIT_SUMMARY, "0");
});
