#!/usr/bin/env node

/**
 * Make a fresh git worktree self-sufficient for the local gate.
 *
 *   node scripts/worktree.mjs setup [--skip-daemon]   idempotent; installs everything below
 *   node scripts/worktree.mjs check [--strict]          read-only; exits 1 and says what is missing (--strict also enforces the release stamp)
 *
 * `setup` installs from the lockfile (`npm ci --ignore-scripts`), installs the husky shim
 * (`.husky/_`, which `npm ci --ignore-scripts` never creates), restores the model data of the
 * published `@earendil-works/pi-ai` release matching the repo version (the source CI uses, never
 * live provider data), and builds the pi-env daemon.
 *
 * `core.hooksPath=.husky/_` is relative and shared by every worktree. Where `.husky/_` is missing
 * git runs no hook at all, so no hook can detect that. `check` is the guard: `npm run check` (the
 * pre-commit gate) runs it first and fails loudly.
 *
 * Blocking (`check`, run by `npm run check`): hook dir, `node_modules`, valid model data. Regenerated
 * but valid data (`npm run build`, release scripts) must never block the gate. The release stamp is
 * advisory there and only enforced by `check --strict` (`npm run worktree:check`). A missing stamp
 * (checkouts that predate this script) is only ever a warning.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const AI_PACKAGE = "@earendil-works/pi-ai";
const MODEL_DATA_STAMP = "pi-model-data-release";

/** Repository root of the checkout (or worktree) this script belongs to. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Release version whose published model data this checkout is pinned to (same as CI). */
export function releaseVersion(root) {
	return JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8")).version;
}

/** Per-worktree file recording which release the hydrated model data came from. */
export function modelDataStampPath(root) {
	return resolve(root, git(root, ["rev-parse", "--git-dir"]), MODEL_DATA_STAMP);
}

function modelDataDir(root) {
	return join(root, "packages/ai/src/providers/data");
}

/** Stamp content: the release plus the digest of the restored manifest, so later regeneration invalidates it. */
function expectedStamp(root) {
	const manifest = join(modelDataDir(root), ".manifest.json");
	const digest = existsSync(manifest) ? createHash("sha256").update(readFileSync(manifest)).digest("hex") : "missing";
	return `${releaseVersion(root)} ${digest}`;
}

function stampIsCurrent(root) {
	const stamp = modelDataStampPath(root);
	return existsSync(stamp) && readFileSync(stamp, "utf8").trim() === expectedStamp(root);
}

/** Problem text when the stamp exists but no longer matches the data, else undefined. A missing stamp is not a mismatch. */
function stampMismatch(root) {
	if (!existsSync(modelDataStampPath(root)) || stampIsCurrent(root)) return undefined;
	return `model data changed since it was restored from the ${AI_PACKAGE}@${releaseVersion(root)} release (regenerated or another release)`;
}

/** Error text when the model data fails the repo's own validator, else undefined. */
function modelDataInvalid(root) {
	try {
		execFileSync(process.execPath, [join(root, "packages/ai/scripts/check-model-data.ts")], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return undefined;
	} catch (error) {
		const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n")[0];
		return `model data is invalid: ${detail || String(error.message)}`;
	}
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
 * Hook, dependency and model-data validity problems always block. The release stamp is
 * advisory (`warnings`) unless `strict`, and a missing stamp is never more than a warning.
 * `hooks: false` skips the hook directory check (GitHub Actions has no husky shim by design).
 */
export function inspect(root, { strict = false, hooks = true } = {}) {
	const problems = [];
	const warnings = [];

	if (hooks) {
		const hooksDir = configuredHooksDir(root);
		if (!hooksDir) problems.push("core.hooksPath is unset, so git runs no pre-commit hook");
		else if (!existsSync(join(hooksDir, "pre-commit"))) {
			problems.push(`git hook directory ${hooksDir} is missing, so git silently runs NO pre-commit hook`);
		}
	}

	const modules = join(root, "node_modules");
	if (!existsSync(modules)) problems.push("node_modules is missing");
	else if (lstatSync(modules).isSymbolicLink())
		problems.push("node_modules is a symlink (borrowed from another checkout)");
	else if (!existsSync(join(modules, "@biomejs/wasm-nodejs")))
		problems.push("node_modules lacks @biomejs/wasm-nodejs");

	if (!existsSync(modelDataDir(root))) problems.push("packages/ai/src/providers/data is missing");
	else {
		const invalid = modelDataInvalid(root);
		if (invalid) problems.push(invalid);
		else {
			const mismatch = stampMismatch(root);
			if (mismatch) (strict ? problems : warnings).push(mismatch);
			else if (!existsSync(modelDataStampPath(root))) {
				warnings.push(
					`model data has no release stamp (run \`npm run worktree:setup\` to restore ${AI_PACKAGE}@${releaseVersion(root)})`,
				);
			}
		}
	}
	return { problems, warnings };
}

/** Blocking problems only; see `inspect`. */
export function findProblems(root, options) {
	return inspect(root, options).problems;
}

function run(root, command, args, env = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const options = { cwd: root, stdio: "inherit", env: { ...process.env, ...env } };
	if (command === "npm") execNpmSync(args, options);
	else execFileSync(command, args, options);
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
	run(root, "npm", ["ci", "--ignore-scripts", "--prefer-offline"]);
}

function installHuskyShim(root) {
	// `npm ci --ignore-scripts` skips the `prepare` script that normally runs `husky`.
	const env = { HUSKY: "1" };
	run(root, process.execPath, [join(root, "node_modules/husky/bin.js")], env);
	if (!existsSync(join(root, ".husky/_/pre-commit"))) throw new Error("husky did not create .husky/_/pre-commit");
}

function restoreModelData(root) {
	const version = releaseVersion(root);
	if (existsSync(modelDataDir(root)) && stampIsCurrent(root)) {
		console.log(`model data already restored from ${AI_PACKAGE}@${version}`);
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	try {
		// Same source as .github/workflows/ci.yml: the published release tarball, exact version.
		// npm verifies the tarball against the registry integrity; the cache is used when warm.
		execNpmSync(
			[
				"pack",
				`${AI_PACKAGE}@${version}`,
				"--pack-destination",
				scratch,
				"--prefer-offline",
				"--ignore-scripts",
				"--loglevel=error",
			],
			{
				cwd: root,
				stdio: ["ignore", "ignore", "inherit"],
			},
		);
		// Relative archive name with cwd=scratch: GNU tar reads `C:\...` as a remote host (`host:path`).
		execFileSync("tar", ["-xzf", `earendil-works-pi-ai-${version}.tgz`], { cwd: scratch });
		const source = join(scratch, "package/dist/providers/data");
		if (!existsSync(source)) throw new Error(`${AI_PACKAGE}@${version} has no dist/providers/data`);
		installValidated(root, source);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	writeFileSync(modelDataStampPath(root), `${expectedStamp(root)}\n`);
}

/**
 * Swap `source` in as the model data, validate it, and roll the previous data back on failure so a
 * bad release never replaces a working set.
 */
export function installValidated(root, source) {
	const target = modelDataDir(root);
	const staging = `${target}.restoring`;
	const previous = `${target}.previous`;
	rmSync(staging, { recursive: true, force: true });
	rmSync(previous, { recursive: true, force: true });
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, staging, { recursive: true });
	const hadPrevious = existsSync(target);
	if (hadPrevious) renameSync(target, previous);
	renameSync(staging, target);
	const invalid = modelDataInvalid(root);
	if (invalid) {
		rmSync(target, { recursive: true, force: true });
		if (hadPrevious) renameSync(previous, target);
		throw new Error(`release model data rejected, previous data restored: ${invalid}`);
	}
	rmSync(previous, { recursive: true, force: true });
}

function buildDaemon(root) {
	// Same script as CI. Cargo honors CARGO_NET_OFFLINE; retry online only for crates the cache lacks.
	const args = ["run", "build:daemon", "--workspace", "packages/env"];
	try {
		run(root, "npm", args, { CARGO_NET_OFFLINE: "true" });
	} catch {
		console.log("offline daemon build failed; retrying with the network for missing crates");
		run(root, "npm", args);
	}
}

export function setup(root, { skipDaemon = false } = {}) {
	installDependencies(root);
	installHuskyShim(root);
	restoreModelData(root);
	if (!skipDaemon) buildDaemon(root);
	const problems = findProblems(root, { strict: true });
	if (problems.length > 0)
		throw new Error(`setup finished but the worktree is still not ready:\n- ${problems.join("\n- ")}`);
	console.log("worktree ready");
}

export function check(root, { strict = false } = {}) {
	// GitHub Actions installs with --ignore-scripts and has no husky shim by design; everything else still applies.
	const hooks = process.env.GITHUB_ACTIONS !== "true";
	const { problems, warnings } = inspect(root, { strict, hooks });
	for (const warning of warnings) console.warn(`warning: ${warning}`);
	if (problems.length === 0) return 0;
	console.error(`This worktree cannot run the local gate:\n- ${problems.join("\n- ")}\nRun: npm run worktree:setup`);
	return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...flags] = process.argv.slice(2);
	try {
		if (command === "setup") setup(repoRoot, { skipDaemon: flags.includes("--skip-daemon") });
		else if (command === "check") process.exitCode = check(repoRoot, { strict: flags.includes("--strict") });
		else {
			console.error("Usage: node scripts/worktree.mjs <setup [--skip-daemon] | check>");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
