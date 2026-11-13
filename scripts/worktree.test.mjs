import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configuredHooksDir, findProblems, modelDataStampPath } from "./worktree.mjs";

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
	writeFileSync(modelDataStampPath(root), "9.9.9\n");
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

test("rejects model data from another release", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(modelDataStampPath(root), "9.9.8\n");
	assert.match(findProblems(root).join("\n"), /not restored from the @earendil-works\/pi-ai@9\.9\.9 release/);
});

test("reports an unset core.hooksPath", (t) => {
	const root = makeRepo(t);
	execFileSync("git", ["-C", root, "config", "--unset", "core.hooksPath"]);
	assert.equal(configuredHooksDir(root), undefined);
	assert.match(findProblems(root).join("\n"), /core\.hooksPath is unset/);
});

test("check exits non-zero locally and is skipped in CI", () => {
	const env = { ...process.env };
	delete env.CI;
	// The real checkout may or may not be set up; only the CI escape hatch is deterministic.
	const ci = spawnSync(process.execPath, [script, "check"], { encoding: "utf8", env: { ...env, CI: "true" } });
	assert.equal(ci.status, 0);
	const usage = spawnSync(process.execPath, [script, "bogus"], { encoding: "utf8", env });
	assert.equal(usage.status, 2);
});
