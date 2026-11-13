import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check, configuredHooksDir, findProblems, inspect, installValidated, modelDataStampPath } from "./worktree.mjs";

const script = fileURLToPath(new URL("./worktree.mjs", import.meta.url));

function makeRepo(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "core.hooksPath", ".husky/_"]);
	mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
	writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ version: "9.9.9" }));
	return root;
}

function makeReady(root) {
	mkdirSync(join(root, ".husky/_"), { recursive: true });
	writeFileSync(join(root, ".husky/_/pre-commit"), "");
	mkdirSync(join(root, "node_modules/@biomejs/wasm-nodejs"), { recursive: true });
	mkdirSync(join(root, "packages/ai/src/providers/data"), { recursive: true });
	// Stand-in for packages/ai/scripts/check-model-data.ts: valid unless the manifest says {"invalid":true}.
	mkdirSync(join(root, "packages/ai/scripts"), { recursive: true });
	writeFileSync(
		join(root, "packages/ai/scripts/check-model-data.ts"),
		`const m = require("node:fs").readFileSync(${JSON.stringify(join(root, "packages/ai/src/providers/data/.manifest.json"))}, "utf8");
if (m.includes("invalid")) {
  console.error("Invalid generated model data:");
  for (let i = 1; i <= 30; i++) console.error("  - anthropic.json problem " + i);
  console.error("\\nModel data is missing or stale. Run npm run hydrate:model-data from the repository root.");
  process.exit(1);
}`,
	);
	writeFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), "{}");
	writeFileSync(modelDataStampPath(root), `9.9.9 ${createHash("sha256").update("{}").digest("hex")}\n`);
}

// #85: a fresh worktree has no .husky/_, so git silently runs no pre-commit hook.
test("reports every missing piece of a fresh worktree", (t) => {
	const root = makeRepo(t);
	const problems = findProblems(root).join("\n");
	assert.match(problems, /silently runs NO pre-commit hook/);
	assert.match(problems, /node_modules is missing/);
	assert.match(problems, /packages\/ai\/src\/providers\/data is missing/);
});

test("accepts a fully set up worktree", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	assert.deepEqual(findProblems(root), []);
});

test("rejects borrowed node_modules symlinks", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	rmSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(tmpdir(), join(root, "node_modules"));
	assert.match(findProblems(root).join("\n"), /node_modules is a symlink/);
});

const strict = { strict: true };

test("a stamp mismatch blocks only under --strict", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(modelDataStampPath(root), "9.9.8 deadbeef\n");
	assert.deepEqual(findProblems(root), []);
	assert.match(inspect(root).warnings.join("\n"), /changed since/);
	assert.match(findProblems(root, strict).join("\n"), /changed since/);
});

// release:*, prepublishOnly and build regenerate valid data; the gate must keep passing.
test("regenerated but valid model data does not block the gate", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), '{"generatedAt":"later"}');
	assert.deepEqual(findProblems(root), []);
	assert.equal(inspect(root).warnings.length, 1);
	assert.equal(findProblems(root, strict).length, 1);
});

// Evidence (#87): `tsc --noEmit` passes on data that fails the validator, and base `check` never read model data.
test("invalid model data only warns in the gate, with the validator output and the right fix", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), '{"invalid":true}');
	assert.deepEqual(findProblems(root), []);
	const warning = inspect(root).warnings.join("\n");
	assert.match(warning, /model data is invalid/);
	assert.match(warning, /Invalid generated model data:/);
	assert.match(warning, /anthropic\.json problem 1\b/);
	assert.doesNotMatch(warning, /problem 21\b/);
	assert.match(warning, /npm run hydrate:model-data/);
	assert.doesNotMatch(warning, /worktree:setup/);
});

test("invalid model data blocks under --strict and never recommends worktree:setup", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), '{"invalid":true}');
	const problems = findProblems(root, strict).join("\n");
	assert.match(problems, /Invalid generated model data:/);
	assert.match(problems, /npm run hydrate:model-data/);
	assert.doesNotMatch(problems, /worktree:setup/);
});

// Checkouts that predate the stamp must not be blocked.
test("a missing stamp is a warning, even under --strict", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	rmSync(modelDataStampPath(root));
	assert.deepEqual(findProblems(root, strict), []);
	assert.match(inspect(root, strict).warnings.join("\n"), /no release stamp/);
});

test("installValidated swaps in valid data", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	const source = mkdtempSync(join(tmpdir(), "pi-source-"));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	writeFileSync(join(source, ".manifest.json"), '{"new":true}');
	installValidated(root, source);
	assert.equal(readFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), "utf8"), '{"new":true}');
	assert.equal(existsSync(join(root, "packages/ai/src/providers/data.previous")), false);
});

test("installValidated rolls back when the new data is invalid", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	const source = mkdtempSync(join(tmpdir(), "pi-source-"));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	writeFileSync(join(source, ".manifest.json"), '{"invalid":true}');
	assert.throws(() => installValidated(root, source), /previous data restored/);
	assert.equal(readFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), "utf8"), "{}");
	assert.equal(existsSync(join(root, "packages/ai/src/providers/data.previous")), false);
});

function dataDir(root) {
	return join(root, "packages/ai/src/providers/data");
}

function validSource(t, content = '{"new":true}') {
	const source = mkdtempSync(join(tmpdir(), "pi-source-"));
	t.after(() => rmSync(source, { recursive: true, force: true }));
	writeFileSync(join(source, ".manifest.json"), content);
	return source;
}

// Crash states: `previous` exists only while the new data is unvalidated, so it is the last good copy.
test("installValidated recovers an interrupted swap where the target is missing", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	renameSync(dataDir(root), `${dataDir(root)}.previous`);
	installValidated(root, validSource(t));
	assert.equal(readFileSync(join(dataDir(root), ".manifest.json"), "utf8"), '{"new":true}');
	assert.equal(existsSync(`${dataDir(root)}.previous`), false);
});

test("installValidated keeps the recovered copy when the new data is then rejected", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	renameSync(dataDir(root), `${dataDir(root)}.previous`);
	assert.throws(() => installValidated(root, validSource(t, '{"invalid":true}')), /previous data restored/);
	assert.equal(readFileSync(join(dataDir(root), ".manifest.json"), "utf8"), "{}");
});

test("installValidated restores the last good copy when a crash left unvalidated data and a previous", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	renameSync(dataDir(root), `${dataDir(root)}.previous`);
	mkdirSync(dataDir(root));
	writeFileSync(join(dataDir(root), ".manifest.json"), '{"invalid":true}');
	assert.throws(() => installValidated(root, validSource(t, '{"invalid":true}')), /previous data restored/);
	assert.equal(readFileSync(join(dataDir(root), ".manifest.json"), "utf8"), "{}");
});

test("installValidated discards a stale staging directory", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	mkdirSync(`${dataDir(root)}.restoring`);
	writeFileSync(join(`${dataDir(root)}.restoring`, "junk"), "x");
	installValidated(root, validSource(t));
	assert.equal(existsSync(`${dataDir(root)}.restoring`), false);
	assert.equal(existsSync(join(dataDir(root), "junk")), false);
});

test("the swap directories are ignored by git", () => {
	const ignored = (path) =>
		spawnSync("git", ["check-ignore", "-q", path], { cwd: join(fileURLToPath(import.meta.url), "../..") }).status ===
		0;
	assert.ok(ignored("packages/ai/src/providers/data.previous/x"));
	assert.ok(ignored("packages/ai/src/providers/data.restoring/x"));
});

test("reports an unset core.hooksPath", (t) => {
	const root = makeRepo(t);
	execFileSync("git", ["-C", root, "config", "--unset", "core.hooksPath"]);
	assert.equal(configuredHooksDir(root), undefined);
	assert.match(findProblems(root).join("\n"), /core\.hooksPath is unset/);
});

test("check exits non-zero locally; GitHub Actions skips only the hook check", () => {
	const env = { ...process.env };
	delete env.GITHUB_ACTIONS;
	// #85: a worktree without the shim must fail the gate with exit 1 and the fix.
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-cli-"));
	try {
		execFileSync("git", ["init", "-q", root]);
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "packages/coding-agent"), { recursive: true });
		copyFileSync(script, join(root, "scripts/worktree.mjs"));
		copyFileSync(fileURLToPath(new URL("./npm-command.mjs", import.meta.url)), join(root, "scripts/npm-command.mjs"));
		writeFileSync(join(root, "packages/coding-agent/package.json"), JSON.stringify({ version: "9.9.9" }));
		execFileSync("git", ["-C", root, "config", "core.hooksPath", ".husky/_"]);
		const local = spawnSync(process.execPath, [join(root, "scripts/worktree.mjs"), "check"], {
			encoding: "utf8",
			env,
		});
		assert.equal(local.status, 1);
		assert.match(local.stderr, /npm run worktree:setup/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const usage = spawnSync(process.execPath, [script, "bogus"], { encoding: "utf8", env });
	assert.equal(usage.status, 2);
});

test("GITHUB_ACTIONS skips the hook check but keeps node_modules and data checks", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	rmSync(join(root, ".husky"), { recursive: true });
	const saved = process.env.GITHUB_ACTIONS;
	const errors = console.error;
	console.error = () => {};
	t.after(() => {
		console.error = errors;
		if (saved === undefined) delete process.env.GITHUB_ACTIONS;
		else process.env.GITHUB_ACTIONS = saved;
	});
	process.env.GITHUB_ACTIONS = "true";
	assert.equal(check(root), 0);
	rmSync(join(root, "node_modules"), { recursive: true });
	assert.equal(check(root), 1);
	process.env.GITHUB_ACTIONS = "false";
	assert.equal(check(root), 1);
});
