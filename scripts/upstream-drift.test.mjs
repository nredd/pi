import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	analyze,
	areaOf,
	code,
	evaluate,
	parseBreakingEntries,
	parseState,
	renderBody,
	renderComment,
	trialIsInconclusive,
	trialIsRed,
	validateArtifact,
} from "./upstream-drift.mjs";

const ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function write(repo, path, content) {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

function commit(repo, files, message) {
	for (const [path, content] of Object.entries(files)) write(repo, path, content);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
}

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- thing\n";

/** Fixture: shared base, `upstream` branch (ahead of base), `fork` branch with a patch stack. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
	git(dir, "init", "-q", "-b", "base");
	commit(
		dir,
		{
			"packages/ai/a.ts": "base\n",
			"packages/tui/t.ts": "t\n",
			"README.md": "r\n",
			"packages/ai/CHANGELOG.md": CHANGELOG,
		},
		"Base",
	);
	git(dir, "branch", "upstream");
	git(dir, "branch", "fork");
	return dir;
}

function onBranch(repo, branch, fn) {
	git(repo, "checkout", "-q", branch);
	fn();
}

test("areaOf groups packages and apps by two segments", () => {
	assert.equal(areaOf("packages/ai/src/x.ts"), "packages/ai");
	assert.equal(areaOf("apps/p2/main.ts"), "apps/p2");
	assert.equal(areaOf("docs/a.md"), "docs");
	assert.equal(areaOf("README.md"), "(root)");
	assert.equal(areaOf("packages/loose.json"), "packages");
});

test("parseBreakingEntries reads bullets only under Breaking Changes", () => {
	const md = [
		"## [Unreleased]",
		"### Breaking Changes",
		"- Removed `foo` ([#1](x))",
		"  continued line",
		"### Added",
		"- Added bar",
		"## [1.0.0] - 2026-01-01",
		"### Breaking Changes",
		"* Renamed baz",
	].join("\n");
	assert.deepEqual(parseBreakingEntries(md), [
		{ version: "Unreleased", text: "Removed `foo` ([#1](x))" },
		{ version: "1.0.0", text: "Renamed baz" },
	]);
});

test("clean merge: counts, areas, patched-file overlap, no conflicts", () => {
	const repo = fixture();
	try {
		onBranch(repo, "upstream", () => {
			commit(repo, { "packages/ai/a.ts": "base\nup\n" }, "Upstream ai change");
			commit(repo, { "packages/tui/t.ts": "t\nup\n", "docs/d.md": "d\n" }, "Upstream tui and docs");
		});
		onBranch(repo, "fork", () => {
			commit(repo, { "packages/ai/other.ts": "fork\n" }, "Fork only");
			commit(repo, { "packages/tui/t.ts": "fork\nt\n" }, "Fork patches tui");
		});
		const trialDir = `${repo}-trial`;
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream", trialDir });
		assert.equal(report.behind, 2);
		assert.equal(report.ahead, 2);
		assert.equal(report.merge.clean, true);
		assert.deepEqual(report.merge.conflicts, []);
		assert.equal(existsSync(trialDir), false, "scratch worktree removed without keepTrial");
		assert.deepEqual(Object.fromEntries(report.areas.map((a) => [a.area, a.commits])), {
			"packages/ai": 1,
			"packages/tui": 1,
			docs: 1,
		});
		assert.deepEqual(report.patchedFiles, ["packages/tui/t.ts"]);
		assert.equal(report.patchedTouches.length, 1);
		assert.equal(report.patchedTouches[0].subject, "Upstream tui and docs");
		assert.equal(evaluate(report, undefined).trips.length, 0);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("keepTrial leaves an uncommitted clean merge in the scratch worktree", () => {
	const repo = fixture();
	const trialDir = `${repo}-trial`;
	try {
		onBranch(repo, "upstream", () => commit(repo, { "docs/d.md": "d\n" }, "Upstream docs"));
		onBranch(repo, "fork", () => commit(repo, { "packages/ai/other.ts": "fork\n" }, "Fork only"));
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream", trialDir, keepTrial: true });
		assert.equal(report.merge.clean, true);
		assert.equal(report.merge.kept, true);
		assert.equal(readFileSync(join(trialDir, "docs/d.md"), "utf8"), "d\n");
		assert.match(git(trialDir, "status", "--porcelain"), /d\.md/);
		assert.equal(git(trialDir, "rev-parse", "HEAD"), git(repo, "rev-parse", "fork"), "merge not committed");
	} finally {
		git(repo, "worktree", "remove", "--force", trialDir);
		rmSync(repo, { recursive: true, force: true });
	}
});

test("conflict: lists conflicted paths, aborts, removes the worktree, trips", () => {
	const repo = fixture();
	const trialDir = `${repo}-trial`;
	try {
		onBranch(repo, "upstream", () =>
			commit(repo, { "packages/ai/a.ts": "upstream\n", "README.md": "up\n" }, "Upstream edits"),
		);
		onBranch(repo, "fork", () => commit(repo, { "packages/ai/a.ts": "fork\n", "README.md": "fk\n" }, "Fork edits"));
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream", trialDir, keepTrial: true });
		assert.equal(report.merge.clean, false);
		assert.deepEqual(report.merge.conflicts, ["README.md", "packages/ai/a.ts"]);
		assert.equal(existsSync(trialDir), false);
		const decision = evaluate(report, undefined);
		assert.deepEqual(
			decision.trips.map((t) => t.id),
			["conflicts"],
		);
		assert.match(renderBody(report, decision, { now: "T" }), /- `packages\/ai\/a\.ts`/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("new breaking entry trips; entries already at the merge base do not", () => {
	const repo = fixture();
	try {
		onBranch(repo, "base", () => {
			commit(
				repo,
				{ "packages/ai/CHANGELOG.md": `${CHANGELOG}\n### Breaking Changes\n\n- Old break\n` },
				"Old breaking entry",
			);
		});
		git(repo, "branch", "-f", "upstream", "base");
		git(repo, "branch", "-f", "fork", "base");
		onBranch(repo, "upstream", () => {
			commit(
				repo,
				{
					"packages/ai/CHANGELOG.md": `${CHANGELOG}\n### Breaking Changes\n\n- Old break\n- Dropped \`legacy()\`\n`,
				},
				"Upstream breaking",
			);
		});
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream" });
		assert.equal(report.merge.clean, undefined, "no trial without trialDir");
		assert.deepEqual(
			report.breaking.map((b) => b.text),
			["Dropped `legacy()`"],
		);
		assert.equal(report.breaking[0].path, "packages/ai/CHANGELOG.md");
		const decision = evaluate(report, undefined);
		assert.equal(decision.trips.length, 1);
		assert.match(decision.trips[0].id, /^breaking:[0-9a-f]{8}$/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("behind threshold edges: equal does not trip, one over does", () => {
	const repo = fixture();
	try {
		onBranch(repo, "upstream", () => {
			for (const n of [1, 2, 3]) commit(repo, { [`docs/${n}.md`]: `${n}\n` }, `Upstream ${n}`);
		});
		const at = analyze({ repo, localRef: "fork", upstreamRef: "upstream", behindThreshold: 3 });
		assert.equal(at.behind, 3);
		assert.equal(evaluate(at, undefined).trips.length, 0);
		const over = analyze({ repo, localRef: "fork", upstreamRef: "upstream", behindThreshold: 2 });
		assert.deepEqual(
			evaluate(over, undefined).trips.map((t) => t.id),
			["behind"],
		);
		const zero = analyze({ repo, localRef: "upstream", upstreamRef: "fork", behindThreshold: 0 });
		assert.equal(zero.behind, 0);
		assert.equal(evaluate(zero, undefined).trips.length, 0, "0 behind never trips even at threshold 0");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

const ALL_GREEN = {
	deps: "success",
	install: "success",
	models: "success",
	build: "success",
	check: "success",
	daemon: "success",
	test: "success",
};

const baseReport = {
	localRef: "origin/main",
	upstreamRef: "upstream/main",
	localSha: "a".repeat(40),
	upstreamSha: "b".repeat(40),
	mergeBase: "c".repeat(40),
	behind: 200,
	ahead: 5,
	behindThreshold: 200,
	areas: [{ area: "packages/ai", commits: 3 }],
	patchedFiles: [],
	patchedTouches: [],
	breaking: [],
	merge: { clean: true, conflicts: [], kept: true },
};

test("pure threshold edges on 200/201 default", () => {
	assert.equal(evaluate({ ...baseReport, behind: 200 }, {}).trips.length, 0);
	assert.deepEqual(
		evaluate({ ...baseReport, behind: 201 }, {}).trips.map((t) => t.id),
		["behind"],
	);
});

test("trial red only counts on a clean merge", () => {
	assert.equal(trialIsRed({ install: "success", build: "success", check: "success", test: "success" }), false);
	assert.equal(trialIsRed({ install: "success", build: "failure", check: "skipped", test: "skipped" }), true);
	assert.equal(trialIsRed({ test: "cancelled" }), true);
	assert.equal(trialIsRed(undefined), false);
	const red = { build: "failure" };
	assert.deepEqual(
		evaluate(baseReport, red).trips.map((t) => t.id),
		["trial"],
	);
	const conflicted = { ...baseReport, merge: { clean: false, conflicts: ["x"], kept: false } };
	assert.deepEqual(
		evaluate(conflicted, red).trips.map((t) => t.id),
		["conflicts"],
	);
});

test("comment only for trips absent from the previous state", () => {
	const report = { ...baseReport, behind: 250 };
	const first = evaluate(report, {});
	assert.deepEqual(
		first.newTrips.map((t) => t.id),
		["behind"],
	);
	const body = renderBody(report, first, { now: "T" });
	assert.deepEqual(parseState(body), { upstreamSha: "b".repeat(40), tripped: ["behind"] });
	const second = evaluate(report, {}, body);
	assert.equal(second.trips.length, 1);
	assert.equal(second.newTrips.length, 0);
	const worse = evaluate({ ...report, merge: { clean: false, conflicts: ["x"], kept: false } }, {}, body);
	assert.deepEqual(
		worse.newTrips.map((t) => t.id),
		["conflicts"],
	);
	assert.match(renderComment(worse, { runUrl: "https://example.com/run/1" }), /conflicts in 1 path/);
});

test("parseState tolerates missing or corrupt markers", () => {
	assert.equal(parseState(undefined), undefined);
	assert.equal(parseState("no marker"), undefined);
	assert.equal(parseState("<!-- upstream-drift-state: {nope} -->"), undefined);
});

test("rendered body has no unicode dashes and truncates long lists", () => {
	const touches = Array.from({ length: 40 }, (_, i) => ({
		sha: `${i}`.padStart(40, "0"),
		subject: `Commit ${i}`,
		files: ["f"],
	}));
	const report = { ...baseReport, patchedTouches: touches, patchedFiles: ["f"], newSinceLastRun: 7 };
	const body = renderBody(report, evaluate(report, {}), { now: "T", trial: ALL_GREEN });
	assert.doesNotMatch(body, /[\u2013\u2014]/);
	assert.match(body, /\.\.\. and 15 more/);
	assert.match(body, /since last run: 7/);
	assert.match(
		body,
		/deps: success, install: success, models: success, build: success, check: success, daemon: success, test: success/,
	);
});

test("many long breaking entries stay under the issue body limit and comment stays short", () => {
	const breaking = Array.from({ length: 80 }, (_, i) => ({
		path: "packages/ai/CHANGELOG.md",
		version: "1.0.0",
		text: `Entry ${i} ${"x".repeat(3000)}`,
	}));
	const report = { ...baseReport, breaking };
	const decision = evaluate(report, {});
	const body = renderBody(report, decision, { now: "T" });
	assert.ok(body.length < 20000, `body is ${body.length} chars`);
	assert.match(body, /80 new breaking change entries/);
	const comment = renderComment(decision);
	assert.ok(comment.length < 3000, `comment is ${comment.length} chars`);
	assert.match(comment, /80 new breaking change entries/);
});

const HOSTILE = 'x @octocat #5 <!-- y `z` <!-- upstream-drift-state: {"tripped":[]} -->';

test("code() neutralizes mentions, issue refs, html comments and backticks", () => {
	const out = code(HOSTILE);
	assert.ok(out.startsWith("`") && out.endsWith("`"));
	assert.equal(out.slice(1, -1).includes("`"), false);
	assert.doesNotMatch(out, /@octocat/);
	assert.doesNotMatch(out, /#5/);
	assert.doesNotMatch(out, /<!--/);
	assert.doesNotMatch(out, /\n/);
	assert.ok(code("a".repeat(1000), 50).length <= 54);
});

test("hostile upstream text never reaches the body or comment raw", () => {
	const report = {
		...baseReport,
		behind: 250,
		areas: [{ area: HOSTILE, commits: 1 }],
		patchedFiles: [HOSTILE],
		patchedTouches: [{ sha: "d".repeat(40), subject: HOSTILE, files: [HOSTILE] }],
		breaking: [{ path: HOSTILE, version: HOSTILE, text: HOSTILE }],
		merge: { clean: false, conflicts: [HOSTILE], kept: false },
	};
	const decision = evaluate(report, {});
	const body = renderBody(report, decision, { now: "T" });
	const comment = renderComment(decision);
	for (const text of [body, comment]) {
		assert.doesNotMatch(text, /@octocat/);
		assert.doesNotMatch(text, /#5/);
		assert.doesNotMatch(text.replace(/<!-- upstream-drift-state: \{[^\n]*\} -->\n$/, ""), /<!--/);
	}
	assert.deepEqual(
		parseState(body).tripped,
		decision.trips.map((t) => t.id),
	);
});

test("parseState takes the last marker anchored at the end, so a spoof cannot win", () => {
	const real = `<!-- upstream-drift-state: {"upstreamSha":"${"a".repeat(40)}","tripped":["behind"]} -->`;
	const spoof = `<!-- upstream-drift-state: {"upstreamSha":"${"b".repeat(40)}","tripped":[]} -->`;
	assert.deepEqual(parseState(`text\n${spoof}\nmore\n${real}\n`).tripped, ["behind"]);
	assert.equal(parseState(`${real}\ntrailing text after the marker\n`), undefined);
	assert.deepEqual(parseState(`${spoof} ${real}\n`).tripped, ["behind"]);
	assert.equal(parseState('<!-- upstream-drift-state: {"tripped":"nope"} -->'), undefined);
});

test("apt failure is inconclusive, not a red trial trip", () => {
	const trial = {
		...ALL_GREEN,
		deps: "failure",
		install: "skipped",
		build: "skipped",
		check: "skipped",
		test: "skipped",
	};
	assert.equal(trialIsInconclusive(trial), true);
	assert.equal(trialIsRed(trial), false);
	assert.deepEqual(evaluate(baseReport, trial).trips, []);
	assert.match(renderBody(baseReport, evaluate(baseReport, trial), { trial, now: "T" }), /inconclusive/);
	assert.equal(trialIsInconclusive(ALL_GREEN), false);
});

test("validateArtifact accepts the allowed shape and rejects everything else", () => {
	const good = {
		upstreamSha: "a".repeat(40),
		merge: { clean: false, conflicts: ["a/b.ts"] },
		trial: { ...ALL_GREEN },
	};
	assert.deepEqual(validateArtifact(good), good);
	const bad = [
		{ ...good, upstreamSha: "main" },
		{ ...good, extra: 1 },
		{ ...good, merge: { clean: "yes", conflicts: [] } },
		{ ...good, merge: { clean: false, conflicts: "x" } },
		{ ...good, merge: { clean: false, conflicts: [1] } },
		{ ...good, merge: { clean: false, conflicts: ["a\nb"] } },
		{ ...good, merge: { clean: false, conflicts: ["x".repeat(600)] } },
		{ ...good, merge: { clean: false, conflicts: Array.from({ length: 5001 }, () => "a") } },
		{ ...good, trial: { ...ALL_GREEN, build: "<script>" } },
		{ ...good, trial: { ...ALL_GREEN, rogue: "success" } },
		null,
		"x",
	];
	for (const value of bad)
		assert.throws(() => validateArtifact(value), undefined, JSON.stringify(value)?.slice(0, 80));
});

test("finalize regenerates facts from git and takes only the validated artifact", () => {
	const repo = fixture();
	const out = mkdtempSync(join(tmpdir(), "drift-cli-"));
	try {
		onBranch(repo, "upstream", () => {
			for (const n of [1, 2, 3]) commit(repo, { [`docs/${n}.md`]: `${n}\n` }, `Upstream ${n} @octocat #5`);
		});
		onBranch(repo, "fork", () => commit(repo, { "packages/ai/other.ts": "fork\n" }, "Fork only"));
		const sha = git(repo, "rev-parse", "upstream");
		const script = fileURLToPath(new URL("./upstream-drift.mjs", import.meta.url));
		const art = join(out, "artifact.json");
		writeFileSync(
			art,
			JSON.stringify({
				upstreamSha: sha,
				merge: { clean: true, conflicts: [] },
				trial: { ...ALL_GREEN, build: "failure" },
			}),
		);
		const run = (...extra) =>
			spawnSync(
				process.execPath,
				[
					script,
					"finalize",
					"--repo",
					repo,
					"--local-ref",
					"fork",
					"--upstream-ref",
					"upstream",
					"--behind-threshold",
					"2",
					"--artifact",
					art,
					"--body-out",
					join(out, "body.md"),
					"--comment-out",
					join(out, "comment.md"),
					...extra,
				],
				{ encoding: "utf8" },
			);
		const first = run();
		assert.equal(first.status, 0, first.stderr);
		assert.deepEqual(JSON.parse(first.stdout).newTrips, ["behind", "trial"]);
		const body = readFileSync(join(out, "body.md"), "utf8");
		assert.match(body, /behind 3, ahead 1/);
		assert.doesNotMatch(body, /@octocat/);
		assert.match(readFileSync(join(out, "comment.md"), "utf8"), /trial build red/);
		writeFileSync(join(out, "previous.md"), body);
		const second = run("--previous-body", join(out, "previous.md"));
		assert.deepEqual(JSON.parse(second.stdout).newTrips, []);
		assert.equal(existsSync(join(out, "comment.md")), false, "stale comment removed");
		// Artifact for a different upstream sha is refused, so stale trial results are never mixed in.
		writeFileSync(
			art,
			JSON.stringify({ upstreamSha: "f".repeat(40), merge: { clean: true, conflicts: [] }, trial: ALL_GREEN }),
		);
		assert.equal(run().status, 1);
		// A schema violation is refused.
		writeFileSync(
			art,
			JSON.stringify({ upstreamSha: sha, merge: { clean: true, conflicts: [] }, trial: { build: "<b>" } }),
		);
		assert.equal(run().status, 1);
		// No artifact (trial job failed): still reports facts, merge "not attempted".
		rmSync(art);
		const missing = run();
		assert.equal(missing.status, 0, missing.stderr);
		assert.match(readFileSync(join(out, "body.md"), "utf8"), /Trial merge: not attempted/);
		assert.equal(spawnSync(process.execPath, [script, "nope"], { encoding: "utf8" }).status, 1);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});

test("pack builds a validated artifact from a report and trial outcomes", () => {
	const out = mkdtempSync(join(tmpdir(), "drift-pack-"));
	try {
		const script = fileURLToPath(new URL("./upstream-drift.mjs", import.meta.url));
		writeFileSync(
			join(out, "report.json"),
			JSON.stringify({
				...baseReport,
				upstreamSha: "c".repeat(40),
				merge: { clean: true, conflicts: [], kept: true },
			}),
		);
		writeFileSync(join(out, "trial.json"), JSON.stringify(ALL_GREEN));
		const result = spawnSync(
			process.execPath,
			[
				script,
				"pack",
				"--report",
				join(out, "report.json"),
				"--trial",
				join(out, "trial.json"),
				"--out",
				join(out, "artifact.json"),
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(out, "artifact.json"), "utf8")), {
			upstreamSha: "c".repeat(40),
			merge: { clean: true, conflicts: [] },
			trial: ALL_GREEN,
		});
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

/** Split the workflow into its top-level job blocks without a YAML dependency (assumes 2-space job keys, 4-space job fields, 6-space step list). */
function workflowJobs() {
	const text = readFileSync(new URL("../.github/workflows/upstream-drift.yml", import.meta.url), "utf8");
	const jobsAt = text.indexOf("\njobs:\n");
	const jobs = {};
	let name;
	for (const line of text.slice(jobsAt + 7).split("\n")) {
		const header = /^ {2}([\w-]+):\s*$/.exec(line);
		if (header) {
			name = header[1];
			jobs[name] = "";
		} else if (name) jobs[name] += `${line}\n`;
	}
	return { text, jobs };
}

test("workflow splits untrusted trial from privileged report and stays on hosted runners", () => {
	const { text, jobs } = workflowJobs();
	assert.deepEqual(Object.keys(jobs).sort(), ["report", "trial"]);
	assert.doesNotMatch(text, /self-hosted/i);
	for (const [name, block] of Object.entries(jobs)) {
		assert.deepEqual(
			[...block.matchAll(/^ {4}runs-on:\s*(.+)$/gm)].map((m) => m[1].trim()),
			["ubuntu-latest"],
			name,
		);
	}
	assert.match(text, /^permissions: \{\}$/m, "no workflow-level token scope");
	const perms = (block) =>
		/^ {4}permissions:\n((?: {6}\S.*\n)+)/m
			.exec(block)?.[1]
			.trim()
			.split("\n")
			.map((l) => l.trim());
	assert.deepEqual(perms(jobs.trial), ["contents: read"]);
	assert.deepEqual(perms(jobs.report)?.sort(), ["contents: read", "issues: write"]);
	assert.match(jobs.report, /needs: trial/);
	assert.match(jobs.report, /if: always\(\)/);
	assert.doesNotMatch(jobs.trial, /GH_TOKEN|github\.token|secrets\./);
	assert.doesNotMatch(text, /actions\/cache/);
	assert.doesNotMatch(text, /^\s+cache:/m, "no setup-node cache, so nothing is saved to the shared cache");
	assert.doesNotMatch(
		jobs.report,
		/npm (ci|install|run|test)|\.\/test\.sh|build:/,
		"report job never builds upstream code",
	);
	assert.doesNotMatch(text, /pull_request/);
	for (const [, ref] of text.matchAll(/uses:\s*\S+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
});

test("a missing trial carries previous conflict and trial trips forward without re-commenting", () => {
	const conflicted = { ...baseReport, merge: { clean: false, conflicts: ["x"], kept: false } };
	const previousBody = renderBody(conflicted, evaluate(conflicted, undefined), { now: "T" });
	const unavailable = { ...baseReport, merge: { clean: undefined, conflicts: [], kept: false } };
	const decision = evaluate(unavailable, undefined, previousBody);
	assert.deepEqual(
		decision.trips.map((t) => t.id),
		["conflicts"],
	);
	assert.deepEqual(decision.newTrips, []);
	assert.match(decision.trips[0].reason, /carried from the previous run/);
	assert.deepEqual(evaluate(baseReport, ALL_GREEN, previousBody).trips, [], "a real clean result clears it");
});

test("parseState rejects a non-sha upstreamSha so it cannot become a git option", () => {
	const body = '<!-- upstream-drift-state: {"upstreamSha":"--output=x","tripped":[]} -->';
	assert.equal(parseState(body)?.upstreamSha, undefined);
});

test("code() never returns an empty span", () => {
	assert.equal(code(""), "`(empty)`");
	assert.equal(code("\u0000\u0001"), "`(empty)`");
});

test("report job holds the token only in the issue steps and checks out the default branch", () => {
	const { jobs } = workflowJobs();
	const header = jobs.report.slice(0, jobs.report.indexOf("    steps:"));
	assert.doesNotMatch(header, /GH_TOKEN/);
	assert.match(jobs.report, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
	for (const step of jobs.report.split(/\n {6}- /)) {
		const usesToken = /GH_TOKEN/.test(step);
		const allowed = /name: (Load rolling issue|Update rolling issue)/.test(step);
		assert.equal(usesToken, allowed, step.split("\n")[0]);
	}
});
