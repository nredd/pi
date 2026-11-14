import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	analyze,
	areaOf,
	evaluate,
	parseBreakingEntries,
	parseState,
	renderBody,
	renderComment,
	trialIsRed,
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
	commit(dir, { "packages/ai/a.ts": "base\n", "packages/tui/t.ts": "t\n", "README.md": "r\n", "packages/ai/CHANGELOG.md": CHANGELOG }, "Base");
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
		assert.deepEqual(
			Object.fromEntries(report.areas.map((a) => [a.area, a.commits])),
			{ "packages/ai": 1, "packages/tui": 1, docs: 1 },
		);
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
		onBranch(repo, "upstream", () => commit(repo, { "packages/ai/a.ts": "upstream\n", "README.md": "up\n" }, "Upstream edits"));
		onBranch(repo, "fork", () => commit(repo, { "packages/ai/a.ts": "fork\n", "README.md": "fk\n" }, "Fork edits"));
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream", trialDir, keepTrial: true });
		assert.equal(report.merge.clean, false);
		assert.deepEqual(report.merge.conflicts, ["README.md", "packages/ai/a.ts"]);
		assert.equal(existsSync(trialDir), false);
		const decision = evaluate(report, undefined);
		assert.deepEqual(decision.trips.map((t) => t.id), ["conflicts"]);
		assert.match(renderBody(report, decision, { now: "T" }), /- `packages\/ai\/a\.ts`/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("new breaking entry trips; entries already at the merge base do not", () => {
	const repo = fixture();
	try {
		onBranch(repo, "base", () => {
			commit(repo, { "packages/ai/CHANGELOG.md": `${CHANGELOG}\n### Breaking Changes\n\n- Old break\n` }, "Old breaking entry");
		});
		git(repo, "branch", "-f", "upstream", "base");
		git(repo, "branch", "-f", "fork", "base");
		onBranch(repo, "upstream", () => {
			commit(repo, { "packages/ai/CHANGELOG.md": `${CHANGELOG}\n### Breaking Changes\n\n- Old break\n- Dropped \`legacy()\`\n` }, "Upstream breaking");
		});
		const report = analyze({ repo, localRef: "fork", upstreamRef: "upstream" });
		assert.equal(report.merge.clean, undefined, "no trial without trialDir");
		assert.deepEqual(report.breaking.map((b) => b.text), ["Dropped `legacy()`"]);
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
		assert.deepEqual(evaluate(over, undefined).trips.map((t) => t.id), ["behind"]);
		const zero = analyze({ repo, localRef: "upstream", upstreamRef: "fork", behindThreshold: 0 });
		assert.equal(zero.behind, 0);
		assert.equal(evaluate(zero, undefined).trips.length, 0, "0 behind never trips even at threshold 0");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

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
	assert.deepEqual(evaluate({ ...baseReport, behind: 201 }, {}).trips.map((t) => t.id), ["behind"]);
});

test("trial red only counts on a clean merge", () => {
	assert.equal(trialIsRed({ install: "success", build: "success", check: "success", test: "success" }), false);
	assert.equal(trialIsRed({ install: "success", build: "failure", check: "skipped", test: "skipped" }), true);
	assert.equal(trialIsRed({ test: "cancelled" }), true);
	assert.equal(trialIsRed(undefined), false);
	const red = { build: "failure" };
	assert.deepEqual(evaluate(baseReport, red).trips.map((t) => t.id), ["trial"]);
	const conflicted = { ...baseReport, merge: { clean: false, conflicts: ["x"], kept: false } };
	assert.deepEqual(evaluate(conflicted, red).trips.map((t) => t.id), ["conflicts"]);
});

test("comment only for trips absent from the previous state", () => {
	const report = { ...baseReport, behind: 250 };
	const first = evaluate(report, {});
	assert.deepEqual(first.newTrips.map((t) => t.id), ["behind"]);
	const body = renderBody(report, first, { now: "T" });
	assert.deepEqual(parseState(body), { upstreamSha: "b".repeat(40), tripped: ["behind"] });
	const second = evaluate(report, {}, body);
	assert.equal(second.trips.length, 1);
	assert.equal(second.newTrips.length, 0);
	const worse = evaluate({ ...report, merge: { clean: false, conflicts: ["x"], kept: false } }, {}, body);
	assert.deepEqual(worse.newTrips.map((t) => t.id), ["conflicts"]);
	assert.match(renderComment(worse, { runUrl: "https://example.com/run/1" }), /conflicts in 1 path/);
});

test("parseState tolerates missing or corrupt markers", () => {
	assert.equal(parseState(undefined), undefined);
	assert.equal(parseState("no marker"), undefined);
	assert.equal(parseState("<!-- upstream-drift-state: {nope} -->"), undefined);
});

test("rendered body has no unicode dashes and truncates long lists", () => {
	const touches = Array.from({ length: 40 }, (_, i) => ({ sha: `${i}`.padStart(40, "0"), subject: `Commit ${i}`, files: ["f"] }));
	const report = { ...baseReport, patchedTouches: touches, patchedFiles: ["f"], newSinceLastRun: 7 };
	const body = renderBody(report, evaluate(report, {}), { now: "T", trial: { install: "success", build: "success", check: "success", test: "success" } });
	assert.doesNotMatch(body, /[\u2013\u2014]/);
	assert.match(body, /\.\.\. and 15 more/);
	assert.match(body, /since last run: 7/);
	assert.match(body, /install: success, build: success, check: success, test: success/);
});

test("many long breaking entries stay under the issue body limit and comment stays short", () => {
	const breaking = Array.from({ length: 80 }, (_, i) => ({ path: "packages/ai/CHANGELOG.md", version: "1.0.0", text: `Entry ${i} ${"x".repeat(3000)}` }));
	const report = { ...baseReport, breaking };
	const decision = evaluate(report, {});
	const body = renderBody(report, decision, { now: "T" });
	assert.ok(body.length < 20000, `body is ${body.length} chars`);
	assert.match(body, /80 new breaking change entries/);
	const comment = renderComment(decision);
	assert.ok(comment.length < 3000, `comment is ${comment.length} chars`);
	assert.match(comment, /80 new breaking change entries/);
});
