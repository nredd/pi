/** Audit every tracked npm lock at all severities, with expiring advisory/package exceptions. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @import { SpawnSyncOptionsWithStringEncoding } from "node:child_process" */
/** @typedef {{ package: string, reason: string, tracking: string, expires: string }} Exception */
/** @typedef {{ stdout: string, stderr: string, status: number | null, error?: Error, signal?: string | null }} CommandResult */
/** @typedef {(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => CommandResult} Runner */

/**
 * Validate policy before executing npm; no package or severity wildcards are supported.
 * @param {Record<string, Exception>} exceptions
 * @param {Date} now
 */
function validateExceptions(exceptions, now) {
	if (!exceptions || typeof exceptions !== "object" || Array.isArray(exceptions))
		throw new Error("Invalid exceptions file");
	for (const [id, entry] of Object.entries(exceptions)) {
		if (
			!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id) ||
			!entry ||
			typeof entry.package !== "string" ||
			!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.package) ||
			typeof entry.reason !== "string" ||
			!entry.reason.trim() ||
			typeof entry.tracking !== "string" ||
			!entry.tracking.trim() ||
			typeof entry.expires !== "string" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) ||
			!Number.isFinite(Date.parse(entry.expires)) ||
			new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires
		) {
			throw new Error(`Invalid exception ${id}`);
		}
		if (now.toISOString().slice(0, 10) > entry.expires)
			throw new Error(`Expired exception ${id} (${entry.expires}); ${entry.tracking}`);
	}
}

/**
 * Parse npm's v2 report and resolve every transitive edge to concrete advisories, failing closed.
 * @param {CommandResult} result
 * @param {Record<string, Exception>} exceptions
 * @param {Set<string>} seen
 * @param {(line: string) => void} log
 */
function inspectAudit(result, exceptions, seen, log) {
	if (result.error || result.signal || (result.status !== 0 && result.status !== 1))
		throw new Error(
			`npm audit execution failed: ${result.error ?? result.signal ?? result.status}; ${result.stderr}`,
		);
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		throw new Error(`npm audit did not produce JSON: ${result.stderr}`);
	}
	if (!report || report.error) throw new Error(`npm audit failed: ${JSON.stringify(report?.error)}`);
	const vulnerabilities = report.vulnerabilities;
	if (
		report.auditReportVersion !== 2 ||
		!vulnerabilities ||
		typeof vulnerabilities !== "object" ||
		Array.isArray(vulnerabilities) ||
		report.metadata?.vulnerabilities?.total !== Object.keys(vulnerabilities).length ||
		(result.status === 0) !== (Object.keys(vulnerabilities).length === 0)
	)
		throw new Error("Invalid npm audit report or exit status");

	const checked = new Set();
	const visiting = new Set();
	const anchored = new Set();
	/** @param {string} name */
	function visit(name) {
		if (checked.has(name)) return;
		// A cycle member's own pass still validates every advisory object.
		if (visiting.has(name)) return;
		const entry = Object.hasOwn(vulnerabilities, name) ? vulnerabilities[name] : undefined;
		if (
			!entry ||
			entry.name !== name ||
			!Array.isArray(entry.via) ||
			entry.via.length === 0 ||
			!Array.isArray(entry.nodes) ||
			entry.nodes.length === 0 ||
			!entry.nodes.every(
				/** @param {unknown} node */
				(node) =>
					typeof node === "string" && (node === `node_modules/${name}` || node.endsWith(`/node_modules/${name}`)),
			)
		)
			throw new Error(`Invalid npm audit finding: ${name}`);
		visiting.add(name);
		for (const via of entry.via) {
			if (typeof via === "string") {
				visit(via);
				continue;
			}
			const id =
				typeof via?.url === "string"
					? /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/.exec(via.url)?.[1]
					: undefined;
			const exception = id && Object.hasOwn(exceptions, id) ? exceptions[id] : undefined;
			if (!id || !exception || exception.package !== name || via.name !== name)
				throw new Error(`Unexcepted advisory ${id ?? JSON.stringify(via)} on ${name}`);
			anchored.add(name);
			seen.add(id);
			log(
				`Excepted ${id} (${name}; ${entry.nodes.join(", ")}) until ${exception.expires}: ${exception.reason}; ${exception.tracking}`,
			);
		}
		visiting.delete(name);
		checked.add(name);
	}
	for (const name of Object.keys(vulnerabilities)) visit(name);
	// Propagate accepted advisory anchors through the graph, including mutual dependencies.
	// A separate unanchored cycle must not be excused by an unrelated accepted advisory.
	let changed;
	do {
		changed = false;
		for (const name of checked) {
			if (
				!anchored.has(name) &&
				vulnerabilities[name].via.some(
					/** @param {unknown} via */
					(via) => typeof via === "string" && anchored.has(via),
				)
			) {
				anchored.add(name);
				changed = true;
			}
		}
	} while (changed);
	const unanchored = [...checked].filter((name) => !anchored.has(name));
	if (unanchored.length)
		throw new Error(`Cyclic npm audit dependencies without an advisory: ${unanchored.join(", ")}`);
}

/**
 * Run all locks before checking stale exceptions globally, not once per clean example lock.
 * @param {{ root: string, exceptions: Record<string, Exception>, now?: Date, run?: Runner, log?: (line: string) => void }} configuration
 */
export function auditLockfiles({ root, exceptions, now = new Date(), run = spawnSync, log = console.log }) {
	validateExceptions(exceptions, now);
	/** @type {SpawnSyncOptionsWithStringEncoding} */
	const options = { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
	const discovery = run("git", ["ls-files", "-z", "--", "package-lock.json", "**/package-lock.json"], options);
	if (discovery.error || discovery.signal || discovery.status !== 0)
		throw new Error("Cannot discover tracked npm lockfiles");
	const locks = discovery.stdout.split("\0").filter(Boolean);
	if (locks.length === 0) throw new Error("No tracked npm lockfiles found");
	const seen = new Set();
	const failures = [];
	for (const lock of locks) {
		log(`Auditing ${lock}`);
		const args = ["audit", "--json", "--package-lock-only", "--audit-level=info", "--prefix", dirname(lock)];
		if (lock !== "package-lock.json") args.push("--workspaces=false");
		try {
			inspectAudit(run("npm", args, options), exceptions, seen, (line) => log(`${lock}: ${line}`));
		} catch (error) {
			const message = `${lock}: ${error instanceof Error ? error.message : String(error)}`;
			log(`::error::${message}`);
			failures.push(message);
		}
	}
	for (const id of Object.keys(exceptions)) {
		if (!seen.has(id)) {
			const message = `Stale exception ${id}; remove it from scripts/fork-audit-exceptions.json (${exceptions[id].tracking})`;
			log(`::error::${message}`);
			failures.push(message);
		}
	}
	if (failures.length) throw new Error(failures.join("\n"));
	log(`Audited ${locks.length} lockfiles; no unexcepted advisories; ${seen.size} active exception(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		auditLockfiles({
			root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
			exceptions: JSON.parse(readFileSync(new URL("./fork-audit-exceptions.json", import.meta.url), "utf8")),
		});
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
