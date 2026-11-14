import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check, configuredHooksDir, findProblems, inspect, restoreModelData } from "./worktree.mjs";

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

// #85, evidence: `tsc --noEmit` passes on data that fails the validator, and base `check` never read model data.
// Covers regenerated data and src ahead of the release data alike.
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
	assert.match(warning, /node scripts\/worktree\.mjs setup --force[\s\S]*npm run hydrate:model-data/);
	assert.doesNotMatch(warning, /worktree:setup/);
});

test("invalid model data blocks under --strict and never recommends worktree:setup", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	writeFileSync(join(root, "packages/ai/src/providers/data/.manifest.json"), '{"invalid":true}');
	const problems = findProblems(root, strict).join("\n");
	assert.match(problems, /Invalid generated model data:/);
	assert.match(problems, /node scripts\/worktree\.mjs setup --force[\s\S]*npm run hydrate:model-data/);
	assert.doesNotMatch(problems, /worktree:setup/);
});

// Setup leaves present data untouched: no reinstall, no network.
test("restoreModelData leaves present data alone, even when invalid", (t) => {
	const root = makeRepo(t);
	makeReady(root);
	const manifest = join(root, "packages/ai/src/providers/data/.manifest.json");
	writeFileSync(manifest, '{"invalid":true}');
	const log = console.log;
	console.log = () => {};
	t.after(() => {
		console.log = log;
	});
	restoreModelData(root);
	assert.equal(readFileSync(manifest, "utf8"), '{"invalid":true}');
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

// #94: argv[1] behind a symlinked prefix (macOS /tmp, or TMPDIR unset under `env -i`) must still run main.
test("check runs as main when the script path is behind a symlink, with and without TMPDIR", (t) => {
	const real = mkdtempSync(join(realpathSync(tmpdir()), "pi-worktree-real-"));
	const link = `${real}-link`;
	symlinkSync(real, link);
	t.after(() => {
		rmSync(link, { force: true });
		rmSync(real, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-q", real]);
	mkdirSync(join(real, "scripts"));
	mkdirSync(join(real, "packages/coding-agent"), { recursive: true });
	copyFileSync(script, join(real, "scripts/worktree.mjs"));
	copyFileSync(fileURLToPath(new URL("./npm-command.mjs", import.meta.url)), join(real, "scripts/npm-command.mjs"));
	writeFileSync(join(real, "packages/coding-agent/package.json"), JSON.stringify({ version: "9.9.9" }));
	execFileSync("git", ["-C", real, "config", "core.hooksPath", ".husky/_"]);
	const viaLink = join(link, "scripts/worktree.mjs");
	for (const env of [{ ...process.env, TMPDIR: link, GITHUB_ACTIONS: "" }, { PATH: process.env.PATH ?? "" }]) {
		const result = spawnSync(process.execPath, [viaLink, "check"], { encoding: "utf8", env });
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /npm run worktree:setup/);
	}
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
