#!/usr/bin/env node

/**
 * Make a fresh git worktree self-sufficient for the local gate.
 *
 *   node scripts/worktree.mjs setup [--skip-daemon]   idempotent; installs everything below
 *   node scripts/worktree.mjs check                   read-only; exits 1 and says what is missing
 *
 * `setup` installs from the lockfile (`npm ci --ignore-scripts`), installs the husky shim
 * (`.husky/_`, which `npm ci --ignore-scripts` never creates), restores the model data of the
 * published `@earendil-works/pi-ai` release matching the repo version (the source CI uses, never
 * live provider data), and builds the pi-env daemon.
 *
 * `core.hooksPath=.husky/_` is relative and shared by every worktree. Where `.husky/_` is missing
 * git runs no hook at all, so no hook can detect that. `check` is the guard: `npm run check` (the
 * pre-commit gate) runs it first and fails loudly.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const AI_PACKAGE = "@earendil-works/pi-ai";
const MODEL_DATA_STAMP = "pi-model-data-release";

/** Repository root of the checkout (or worktree) this script belongs to. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Release version whose published model data this checkout is pinned to (same as CI). */
export function releaseVersion(root) {
	return readJson(join(root, "packages/coding-agent/package.json")).version;
}

/** Per-worktree file recording which release the hydrated model data came from. */
export function modelDataStampPath(root) {
	return resolve(root, git(root, ["rev-parse", "--git-dir"]), MODEL_DATA_STAMP);
}

function modelDataDir(root) {
	return join(root, "packages/ai/src/providers/data");
}

/** Directory git will run hooks from for this worktree, or undefined when unset. */
export function configuredHooksDir(root) {
	let hooksPath;
	try {
		hooksPath = git(root, ["config", "--get", "core.hooksPath"]);
	} catch {
		return undefined;
	}
	return resolve(root, hooksPath);
}

/**
 * Problems that make this worktree unable to run its own gate. Empty means ready.
 * Hook and dependency problems are always reported; model data is checked against the stamp.
 */
export function findProblems(root) {
	const problems = [];

	const hooksDir = configuredHooksDir(root);
	if (!hooksDir) problems.push("core.hooksPath is unset, so git runs no pre-commit hook");
	else if (!existsSync(join(hooksDir, "pre-commit"))) {
		problems.push(`git hook directory ${hooksDir} is missing, so git silently runs NO pre-commit hook`);
	}

	const modules = join(root, "node_modules");
	if (!existsSync(modules)) problems.push("node_modules is missing");
	else if (lstatSync(modules).isSymbolicLink()) problems.push("node_modules is a symlink (borrowed from another checkout)");
	else if (!existsSync(join(modules, "@biomejs/wasm-nodejs"))) problems.push("node_modules lacks @biomejs/wasm-nodejs");

	const stamp = modelDataStampPath(root);
	const expected = releaseVersion(root);
	if (!existsSync(modelDataDir(root))) problems.push("packages/ai/src/providers/data is missing");
	else if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== expected) {
		problems.push(`model data was not restored from the ${AI_PACKAGE}@${expected} release`);
	}
	return problems;
}

function run(root, command, args, env = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	execFileSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
}

function runNpm(root, args, env = {}) {
	console.log(`$ npm ${args.join(" ")}`);
	execNpmSync(args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
}

function installDependencies(root) {
	const modules = join(root, "node_modules");
	if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
	const lockfile = join(root, "package-lock.json");
	const installed = join(modules, ".package-lock.json");
	const current =
		existsSync(installed) &&
		statSync(installed).mtimeMs >= statSync(lockfile).mtimeMs &&
		existsSync(join(modules, "@biomejs/wasm-nodejs"));
	if (current) {
		console.log("node_modules is up to date with package-lock.json");
		return;
	}
	// Cache first, network only for what the cache lacks. Integrity comes from the lockfile.
	runNpm(root, ["ci", "--ignore-scripts", "--prefer-offline"]);
}

function installHuskyShim(root) {
	// `npm ci --ignore-scripts` skips the `prepare` script that normally runs `husky`.
	const env = { HUSKY: "1" };
	run(root, process.execPath, [join(root, "node_modules/husky/bin.js")], env);
	if (!existsSync(join(root, ".husky/_/pre-commit"))) throw new Error("husky did not create .husky/_/pre-commit");
}

function restoreModelData(root) {
	const version = releaseVersion(root);
	const stamp = modelDataStampPath(root);
	if (existsSync(modelDataDir(root)) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
		console.log(`model data already restored from ${AI_PACKAGE}@${version}`);
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	try {
		// Same source as .github/workflows/ci.yml: the published release tarball, exact version.
		// npm verifies the tarball against the registry integrity; the cache is used when warm.
		execNpmSync(["pack", `${AI_PACKAGE}@${version}`, "--pack-destination", scratch, "--prefer-offline", "--ignore-scripts", "--loglevel=error"], {
			cwd: root,
			stdio: ["ignore", "ignore", "inherit"],
		});
		const tarball = join(scratch, `earendil-works-pi-ai-${version}.tgz`);
		execFileSync("tar", ["-xzf", tarball, "-C", scratch]);
		const source = join(scratch, "package/dist/providers/data");
		if (!existsSync(source)) throw new Error(`${AI_PACKAGE}@${version} has no dist/providers/data`);
		const target = modelDataDir(root);
		const staging = `${target}.restoring`;
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, staging, { recursive: true });
		rmSync(target, { recursive: true, force: true });
		renameSync(staging, target);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	// Fail loudly if the release data does not match what this checkout's source expects.
	run(root, process.execPath, [join(root, "packages/ai/scripts/check-model-data.ts")]);
	writeFileSync(stamp, `${version}\n`);
}

function buildDaemon(root) {
	const args = ["build", "--manifest-path", "packages/env/daemon/Cargo.toml", "--locked"];
	try {
		run(root, "cargo", [...args, "--offline"]);
	} catch {
		console.log("offline cargo build failed; retrying with the network for missing crates");
		run(root, "cargo", args);
	}
}

export function setup(root, { skipDaemon = false } = {}) {
	installDependencies(root);
	installHuskyShim(root);
	restoreModelData(root);
	if (!skipDaemon) buildDaemon(root);
	const problems = findProblems(root);
	if (problems.length > 0) throw new Error(`setup finished but the worktree is still not ready:\n- ${problems.join("\n- ")}`);
	console.log("worktree ready");
}

export function check(root) {
	// CI installs with --ignore-scripts and restores model data inline; it has no husky shim by design.
	if (process.env.CI === "true") return 0;
	const problems = findProblems(root);
	if (problems.length === 0) return 0;
	console.error(`This worktree cannot run the local gate:\n- ${problems.join("\n- ")}\nRun: npm run worktree:setup`);
	return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...flags] = process.argv.slice(2);
	try {
		if (command === "setup") setup(repoRoot, { skipDaemon: flags.includes("--skip-daemon") });
		else if (command === "check") process.exitCode = check(repoRoot);
		else {
			console.error("Usage: node scripts/worktree.mjs <setup [--skip-daemon] | check>");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
