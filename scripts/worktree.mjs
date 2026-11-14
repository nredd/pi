#!/usr/bin/env node

/**
 * Make a fresh git worktree self-sufficient for the local gate.
 *
 *   node scripts/worktree.mjs setup [--skip-daemon] [--force]   idempotent; installs everything below
 *   node scripts/worktree.mjs check [--strict]                  read-only; exits 1 and says what is missing (--strict also fails on invalid model data)
 *
 * `setup` installs from the lockfile (`npm ci --ignore-scripts`), installs the husky shim
 * (`.husky/_`, which `npm ci --ignore-scripts` never creates), installs the model data of the
 * published `@earendil-works/pi-ai` release matching the repo version when none is present (the
 * source CI uses, never live provider data; `--force` reinstalls), and builds the pi-env daemon.
 * Like CI it does not gate on the release data: a validator failure (e.g. src ahead of the release)
 * only warns, with the `setup --force` / `npm run hydrate:model-data` remedies, and never stops the daemon build.
 *
 * `core.hooksPath=.husky/_` is relative and shared by every worktree. Where `.husky/_` is missing
 * git runs no hook at all, so no hook can detect that. `check` is the guard: `npm run check` (the
 * pre-commit gate) runs it first and fails loudly. It blocks on hook dir, `node_modules` and missing
 * model data; invalid data (regenerated, or stale against src after a merge) only warns there and
 * blocks under `check --strict` (`npm run worktree:check`).
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const AI_PACKAGE = "@earendil-works/pi-ai";

/** Repository root of the checkout (or worktree) this script belongs to. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Release version whose published model data this checkout is pinned to (same as CI). */
export function releaseVersion(root) {
	return JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8")).version;
}

function modelDataDir(root) {
	return join(root, "packages/ai/src/providers/data");
}

const INVALID_DATA_HINT =
	"Run `node scripts/worktree.mjs setup --force` (reinstalls the release data, like CI), or `npm run hydrate:model-data` (or `npm run build`) to regenerate it";
const INVALID_OUTPUT_LINES = 20;

/** Error text (validator output, bounded, plus the fix) when the model data fails the repo's own validator, else undefined. */
function modelDataInvalid(root) {
	try {
		execFileSync(process.execPath, [join(root, "packages/ai/scripts/check-model-data.ts")], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return undefined;
	} catch (error) {
		const lines = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n");
		const shown = lines.slice(0, INVALID_OUTPUT_LINES).join("\n  ");
		const more =
			lines.length > INVALID_OUTPUT_LINES ? `\n  ... ${lines.length - INVALID_OUTPUT_LINES} more lines` : "";
		return `model data is invalid:\n  ${shown || String(error.message)}${more}\n${INVALID_DATA_HINT}`;
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
 * Hook, dependency and missing model data always block. Model data that exists but fails the
 * validator is advisory (`warnings`) unless `strict`: `tsc` passes on such data and the gate never
 * read model data before, so stale-vs-src data must not block commits.
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
		if (invalid) (strict ? problems : warnings).push(invalid);
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

export function restoreModelData(root, { force = false } = {}) {
	const target = modelDataDir(root);
	if (existsSync(target) && !force) {
		console.log("model data present, leaving it alone (--force reinstalls the release data)");
		return;
	}
	const version = releaseVersion(root);
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
		rmSync(target, { recursive: true, force: true });
		mkdirSync(dirname(target), { recursive: true });
		try {
			cpSync(source, target, { recursive: true });
		} catch (error) {
			// Never leave a partial dir behind: a present dir is trusted by the next setup.
			rmSync(target, { recursive: true, force: true });
			throw error;
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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

export function setup(root, { skipDaemon = false, force = false } = {}) {
	installDependencies(root);
	installHuskyShim(root);
	restoreModelData(root, { force });
	if (!skipDaemon) buildDaemon(root);
	const { problems, warnings } = inspect(root);
	for (const warning of warnings) console.warn(`warning: ${warning}`);
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
	// Invalid data is fixed by regeneration (the problem text says how), never by setup.
	const setupFixes = problems.some((problem) => !problem.startsWith("model data is invalid"));
	const footer = setupFixes ? "\nRun: npm run worktree:setup" : "";
	console.error(`This worktree cannot run the local gate:\n- ${problems.join("\n- ")}${footer}`);
	return 1;
}

/** True when this file is the entry script. Compares real paths: argv[1] keeps a symlinked prefix (macOS /tmp) that import.meta.url resolves. */
function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMainModule()) {
	const [command, ...flags] = process.argv.slice(2);
	try {
		if (command === "setup")
			setup(repoRoot, { skipDaemon: flags.includes("--skip-daemon"), force: flags.includes("--force") });
		else if (command === "check") process.exitCode = check(repoRoot, { strict: flags.includes("--strict") });
		else {
			console.error("Usage: node scripts/worktree.mjs <setup [--skip-daemon] [--force] | check [--strict]>");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
