#!/usr/bin/env node
// Upstream drift canary for the fork. Read-only toward upstream: it only fetches (done by the
// caller), inspects history, and trial-merges in a detached scratch worktree. It never pushes.
//
//   node scripts/upstream-drift.mjs analyze  --repo . --local-ref HEAD --upstream-ref upstream/main \
//       --out report.json [--trial-dir DIR [--keep-trial]] [--previous-body prev.md]
//   node scripts/upstream-drift.mjs finalize --report report.json [--trial trial.json] \
//       [--previous-body prev.md] --body-out body.md --comment-out comment.md [--run-url URL]
//
// `analyze` collects the facts. `finalize` folds in the trial build results, decides which
// thresholds tripped, renders the rolling issue body, and writes a comment only for new trips.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_BEHIND_THRESHOLD = 200;
export const STATE_MARKER = "upstream-drift-state";
const MAX_LISTED = 25;
const MAX_AREAS = 15;
const MAX_TEXT = 160;
const MAX_COMMENT_BREAKING = 5;
const TRIAL_STEPS = ["deps", "install", "models", "build", "check", "daemon", "test"];
const RED_OUTCOMES = new Set(["failure", "cancelled", "timed_out"]);

/**
 * Run git and return trimmed-at-the-end stdout. With `allowFail`, a non-zero exit returns the
 * captured streams instead of throwing.
 */
export function git(cwd, args, { allowFail = false } = {}) {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 512 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		if (!allowFail) {
			const stderr = error.stderr?.toString() ?? "";
			throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`);
		}
		return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? "", stderr: error.stderr?.toString() ?? "" };
	}
}

/** Top-level area for a path: `packages/<name>` and `apps/<name>` get two segments. */
export function areaOf(path) {
	const parts = path.split("/");
	if (parts.length === 1) return "(root)";
	if ((parts[0] === "packages" || parts[0] === "apps") && parts.length > 2) return `${parts[0]}/${parts[1]}`;
	return parts[0];
}

/** Parse `### Breaking Changes` bullets out of a package CHANGELOG. Entry identity is the first line. */
export function parseBreakingEntries(markdown) {
	const entries = [];
	let version = "";
	let inBreaking = false;
	for (const line of markdown.split("\n")) {
		const versionMatch = /^##\s+\[?([^\]\s]+)\]?/.exec(line);
		if (versionMatch && !line.startsWith("###")) {
			version = versionMatch[1];
			inBreaking = false;
			continue;
		}
		const sectionMatch = /^###\s+(.*?)\s*$/.exec(line);
		if (sectionMatch) {
			inBreaking = sectionMatch[1].toLowerCase() === "breaking changes";
			continue;
		}
		if (inBreaking && /^[-*]\s+\S/.test(line)) {
			entries.push({ version, text: line.replace(/^[-*]\s+/, "").trim() });
		}
	}
	return entries;
}

/** Parse `git log --name-only --format=@@%H%x09%s` output into commits with their files. */
export function parseLog(output) {
	const commits = [];
	let current;
	for (const line of output.split("\n")) {
		if (line.startsWith("@@")) {
			const [sha, ...subject] = line.slice(2).split("\t");
			current = { sha, subject: subject.join("\t"), files: [] };
			commits.push(current);
		} else if (line && current) {
			current.files.push(line);
		}
	}
	return commits;
}

/** Collapse whitespace and cap length so one long entry cannot blow the issue body limit. */
export function clip(text, max = MAX_TEXT) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function lines(text) {
	return text.split("\n").filter(Boolean);
}

function revCount(repo, range) {
	return Number.parseInt(git(repo, ["rev-list", "--count", range]).stdout.trim(), 10);
}

/** Read the machine-readable state marker from a previous issue body, or `undefined`. */
export function parseState(body) {
	if (!body) return undefined;
	const match = new RegExp(`<!--\\s*${STATE_MARKER}:\\s*(\\{.*?\\})\\s*-->`, "s").exec(body);
	if (!match) return undefined;
	try {
		const state = JSON.parse(match[1]);
		return state && typeof state === "object" ? state : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Trial merge `upstreamRef` into a detached worktree at `localRef` without committing.
 * Aborts and removes the worktree on conflict. A clean merge is left in place only with `keep`.
 */
export function trialMerge(repo, { localRef, upstreamRef, dir, keep }) {
	rmSync(dir, { recursive: true, force: true });
	git(repo, ["worktree", "add", "--detach", dir, localRef]);
	const cleanup = () => {
		git(repo, ["worktree", "remove", "--force", dir], { allowFail: true });
		git(repo, ["worktree", "prune"], { allowFail: true });
	};
	try {
		const result = git(dir, ["merge", "--no-commit", "--no-ff", upstreamRef], { allowFail: true });
		const conflicts = lines(git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout).sort();
		if (result.status !== 0 && conflicts.length === 0) {
			throw new Error(`trial merge failed without conflicts: ${(result.stderr || result.stdout).trim()}`);
		}
		if (conflicts.length > 0) {
			git(dir, ["merge", "--abort"], { allowFail: true });
			cleanup();
			return { clean: false, conflicts, kept: false };
		}
		if (!keep) {
			cleanup();
			return { clean: true, conflicts: [], kept: false };
		}
		return { clean: true, conflicts: [], kept: true };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/** Collect drift facts. `trialDir` enables the trial merge. */
export function analyze({
	repo,
	localRef,
	upstreamRef,
	trialDir,
	keepTrial = false,
	previousBody,
	behindThreshold = DEFAULT_BEHIND_THRESHOLD,
}) {
	const base = git(repo, ["merge-base", localRef, upstreamRef]).stdout.trim();
	const behind = revCount(repo, `${localRef}..${upstreamRef}`);
	const ahead = revCount(repo, `${upstreamRef}..${localRef}`);
	const upstreamSha = git(repo, ["rev-parse", upstreamRef]).stdout.trim();
	const localSha = git(repo, ["rev-parse", localRef]).stdout.trim();

	const upstreamCommits = parseLog(
		git(repo, ["log", "--name-only", "--no-renames", "--format=@@%H%x09%s", `${base}..${upstreamRef}`]).stdout,
	);

	const areaCounts = new Map();
	for (const commit of upstreamCommits) {
		for (const area of new Set(commit.files.map(areaOf))) areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
	}
	const areas = [...areaCounts].map(([area, commits]) => ({ area, commits })).sort((a, b) => b.commits - a.commits || a.area.localeCompare(b.area));

	const forkPatched = new Set(lines(git(repo, ["diff", "--name-only", "--no-renames", base, localRef]).stdout));
	const patchedTouches = [];
	for (const commit of upstreamCommits) {
		const files = commit.files.filter((file) => forkPatched.has(file));
		if (files.length > 0) patchedTouches.push({ sha: commit.sha, subject: commit.subject, files });
	}
	const patchedFiles = [...new Set(patchedTouches.flatMap((touch) => touch.files))].sort();

	const changelogs = lines(git(repo, ["diff", "--name-only", "--no-renames", base, upstreamRef, "--", "packages/*/CHANGELOG.md"]).stdout);
	const breaking = [];
	for (const path of changelogs) {
		const show = (ref) => {
			const result = git(repo, ["show", `${ref}:${path}`], { allowFail: true });
			return result.status === 0 ? result.stdout : "";
		};
		const known = new Set(parseBreakingEntries(show(base)).map((entry) => entry.text));
		for (const entry of parseBreakingEntries(show(upstreamRef))) {
			if (!known.has(entry.text)) breaking.push({ path, version: entry.version, text: entry.text });
		}
	}

	const previous = parseState(previousBody);
	let newSinceLastRun;
	if (previous?.upstreamSha && git(repo, ["cat-file", "-e", `${previous.upstreamSha}^{commit}`], { allowFail: true }).status === 0) {
		newSinceLastRun = revCount(repo, `${previous.upstreamSha}..${upstreamRef}`);
	}

	const merge = trialDir
		? trialMerge(repo, { localRef, upstreamRef, dir: resolve(trialDir), keep: keepTrial })
		: { clean: undefined, conflicts: [], kept: false };

	return {
		localRef,
		upstreamRef,
		localSha,
		upstreamSha,
		mergeBase: base,
		behind,
		ahead,
		behindThreshold,
		newSinceLastRun,
		areas,
		patchedFiles,
		patchedTouches,
		breaking,
		merge,
	};
}

/** True when a trial result has any red step. Missing or skipped steps are not red. */
export function trialIsRed(trial) {
	return TRIAL_STEPS.some((step) => RED_OUTCOMES.has(trial?.[step]));
}

/**
 * Decide threshold trips. Trip ids are stable so a repeat of the same trip is not "new":
 * `behind`, `conflicts`, `trial`, `breaking:<hash>`.
 */
export function evaluate(report, trial, previousBody) {
	const trips = [];
	if (report.behind > report.behindThreshold) {
		trips.push({ id: "behind", reason: `behind upstream by ${report.behind} commits (threshold ${report.behindThreshold})` });
	}
	if (report.merge.clean === false) {
		trips.push({ id: "conflicts", reason: `trial merge conflicts in ${report.merge.conflicts.length} path(s)` });
	}
	if (report.merge.clean === true && trialIsRed(trial)) {
		const red = TRIAL_STEPS.filter((step) => RED_OUTCOMES.has(trial[step]));
		trips.push({ id: "trial", reason: `trial ${red.join(", ")} red on a clean merge` });
	}
	for (const entry of report.breaking) {
		trips.push({ id: `breaking:${createHash("sha256").update(`${entry.path}\n${entry.text}`).digest("hex").slice(0, 8)}`, reason: `breaking change in \`${entry.path}\` (${entry.version}): ${clip(entry.text)}` });
	}
	const previous = new Set(parseState(previousBody)?.tripped ?? []);
	const newTrips = trips.filter((trip) => !previous.has(trip.id));
	return { trips, newTrips };
}

/** One line per trip, except breaking entries: a count plus the first few. */
function tripLines(trips, maxBreaking = 0) {
	const breaking = trips.filter((trip) => trip.id.startsWith("breaking:"));
	const out = trips.filter((trip) => !trip.id.startsWith("breaking:")).map((trip) => `- ${trip.reason}`);
	if (breaking.length > 0) {
		out.push(`- ${breaking.length} new breaking change entr${breaking.length === 1 ? "y" : "ies"} (listed below)`);
		for (const trip of breaking.slice(0, maxBreaking)) out.push(`  - ${trip.reason}`);
	}
	return out;
}

function truncateList(items, render, limit = MAX_LISTED) {
	const shown = items.slice(0, limit).map(render);
	if (items.length > limit) shown.push(`- ... and ${items.length - limit} more`);
	return shown;
}

function trialSummary(report, trial) {
	if (report.merge.clean === undefined) return "not attempted";
	if (!report.merge.clean) return "skipped (conflicts)";
	return TRIAL_STEPS.map((step) => `${step}: ${trial?.[step] ?? "not run"}`).join(", ");
}

/** Render the rolling issue body, including the machine-readable state marker. */
export function renderBody(report, decision, { trial, runUrl, now = new Date().toISOString() } = {}) {
	const out = [];
	out.push(`Upstream drift canary, updated ${now}${runUrl ? ` ([run](${runUrl}))` : ""}.`);
	out.push("");
	out.push(`Status: ${decision.trips.length === 0 ? "no thresholds tripped" : `${decision.trips.length} threshold(s) tripped`}`);
	out.push(...tripLines(decision.trips));
	out.push("");
	out.push("Drift:");
	out.push(`- \`${report.localRef}\` ${report.localSha.slice(0, 10)} vs \`${report.upstreamRef}\` ${report.upstreamSha.slice(0, 10)}, merge base ${report.mergeBase.slice(0, 10)}`);
	out.push(`- behind ${report.behind}, ahead ${report.ahead} (threshold ${report.behindThreshold})`);
	if (report.newSinceLastRun !== undefined) out.push(`- new upstream commits since last run: ${report.newSinceLastRun}`);
	out.push("");
	out.push("Upstream commits by area (a commit counts once per area it touches):");
	if (report.areas.length === 0) out.push("- none");
	out.push(...truncateList(report.areas, (entry) => `- \`${entry.area}\`: ${entry.commits}`, MAX_AREAS));
	out.push("");
	out.push(`Trial merge: ${report.merge.clean === undefined ? "not attempted" : report.merge.clean ? "clean" : "conflicts"}`);
	out.push(...truncateList(report.merge.conflicts, (path) => `- \`${path}\``));
	out.push(`Trial steps: ${trialSummary(report, trial)}`);
	out.push("");
	out.push(`Upstream commits touching fork-patched files (${report.patchedTouches.length} commits, ${report.patchedFiles.length} files):`);
	if (report.patchedTouches.length === 0) out.push("- none");
	out.push(...truncateList(report.patchedTouches, (touch) => `- ${touch.sha.slice(0, 10)} ${clip(touch.subject)} (${touch.files.length} file(s))`));
	out.push("");
	out.push(`New \`### Breaking Changes\` entries (${report.breaking.length}):`);
	if (report.breaking.length === 0) out.push("- none");
	out.push(...truncateList(report.breaking, (entry) => `- \`${entry.path}\` ${entry.version}: ${clip(entry.text)}`));
	out.push("");
	const state = { upstreamSha: report.upstreamSha, tripped: decision.trips.map((trip) => trip.id) };
	out.push(`<!-- ${STATE_MARKER}: ${JSON.stringify(state)} -->`);
	return `${out.join("\n")}\n`;
}

/** Render the comment posted for new trips only. */
export function renderComment(decision, { runUrl } = {}) {
	const out = ["New upstream drift threshold trip(s):"];
	out.push(...tripLines(decision.newTrips, MAX_COMMENT_BREAKING));
	if (runUrl) out.push("", `Run: ${runUrl}`);
	return `${out.join("\n")}\n`;
}

function readOptional(path) {
	return path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function main(argv) {
	const [command, ...rest] = argv;
	const { values } = parseArgs({
		args: rest,
		options: {
			repo: { type: "string", default: "." },
			"local-ref": { type: "string", default: "HEAD" },
			"upstream-ref": { type: "string", default: "upstream/main" },
			"trial-dir": { type: "string" },
			"keep-trial": { type: "boolean", default: false },
			"previous-body": { type: "string" },
			"behind-threshold": { type: "string", default: String(DEFAULT_BEHIND_THRESHOLD) },
			out: { type: "string" },
			report: { type: "string" },
			trial: { type: "string" },
			"body-out": { type: "string" },
			"comment-out": { type: "string" },
			"run-url": { type: "string" },
		},
	});
	const previousBody = readOptional(values["previous-body"]);
	if (command === "analyze") {
		const threshold = Number.parseInt(values["behind-threshold"], 10);
		if (!Number.isInteger(threshold) || threshold < 0) throw new Error("--behind-threshold must be a non-negative integer");
		const report = analyze({
			repo: resolve(values.repo),
			localRef: values["local-ref"],
			upstreamRef: values["upstream-ref"],
			trialDir: values["trial-dir"],
			keepTrial: values["keep-trial"],
			previousBody,
			behindThreshold: threshold,
		});
		const json = `${JSON.stringify(report, null, 2)}\n`;
		if (values.out) writeFileSync(values.out, json);
		else process.stdout.write(json);
		return;
	}
	if (command === "finalize") {
		if (!values.report || !values["body-out"]) throw new Error("finalize needs --report and --body-out");
		const report = JSON.parse(readFileSync(values.report, "utf8"));
		const trialText = readOptional(values.trial);
		const trial = trialText ? JSON.parse(trialText) : undefined;
		const decision = evaluate(report, trial, previousBody);
		writeFileSync(values["body-out"], renderBody(report, decision, { trial, runUrl: values["run-url"] }));
		const commentOut = values["comment-out"];
		if (commentOut) {
			rmSync(commentOut, { force: true });
			if (decision.newTrips.length > 0) writeFileSync(commentOut, renderComment(decision, { runUrl: values["run-url"] }));
		}
		process.stdout.write(`${JSON.stringify({ trips: decision.trips.map((t) => t.id), newTrips: decision.newTrips.map((t) => t.id) })}\n`);
		return;
	}
	throw new Error("usage: upstream-drift.mjs <analyze|finalize> [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
