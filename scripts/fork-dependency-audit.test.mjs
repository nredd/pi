import assert from "node:assert/strict";
import test from "node:test";
import { auditLockfiles } from "./fork-dependency-audit.mjs";

const id = "GHSA-fc5q-39xc-vjpf";
const exceptions = {
	[id]: {
		package: "picomatch",
		reason: "Dev tooling; no patch; hostile extglob required",
		tracking: "nredd/pi#118",
		expires: "2026-12-17",
	},
};
const advisory = { name: "picomatch", url: `https://github.com/advisories/${id}` };
const finding = { name: "picomatch", via: [advisory], nodes: ["node_modules/picomatch"] };
/** @param {Record<string, unknown>} vulnerabilities */
const report = (vulnerabilities) =>
	JSON.stringify({
		auditReportVersion: 2,
		vulnerabilities,
		metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
	});
/** @param {string} stdout @param {number | null} status */
const result = (stdout, status = 1) => ({ stdout, stderr: "", status });

// #118: only the explicitly reviewed advisory/package pair can unblock the full CI gate.
/** @type {[string, { stdout: string, stderr: string, status: number | null, error?: Error }, { now?: Date }, RegExp | null][]} */
const cases = [
	["excepted advisory", result(report({ picomatch: finding })), {}, null],
	[
		"another advisory",
		result(
			report({
				picomatch: {
					...finding,
					via: [advisory, { ...advisory, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
				},
			}),
		),
		{},
		/Unexcepted advisory GHSA-aaaa-bbbb-cccc on picomatch/,
	],
	[
		"picomatch advisory object on another entry",
		result(report({ other: { ...finding, name: "other", nodes: ["node_modules/other"] } })),
		{},
		/Unexcepted advisory .* on other/,
	],
	[
		"same id on another package",
		result(
			report({ other: { name: "other", via: [{ ...advisory, name: "other" }], nodes: ["node_modules/other"] } }),
		),
		{},
		/Unexcepted advisory .* on other/,
	],
	[
		"advisory name disagrees with excepted entry",
		result(report({ picomatch: { ...finding, via: [{ ...advisory, name: "other" }] } })),
		{},
		/Unexcepted advisory .* on picomatch/,
	],
	[
		"mismatched entry name",
		result(report({ picomatch: { ...finding, name: "other" } })),
		{},
		/Invalid npm audit finding: picomatch/,
	],
	[
		"bad nodes",
		result(report({ picomatch: { ...finding, nodes: ["node_modules/other"] } })),
		{},
		/Invalid npm audit finding: picomatch/,
	],
	[
		"missing nodes",
		result(report({ picomatch: { name: "picomatch", via: [advisory] } })),
		{},
		/Invalid npm audit finding: picomatch/,
	],
	[
		"empty nodes",
		result(report({ picomatch: { ...finding, nodes: [] } })),
		{},
		/Invalid npm audit finding: picomatch/,
	],
	["status 1 with empty report", result(report({})), {}, /Invalid npm audit report or exit status/],
	["status 0 with findings", result(report({ picomatch: finding }), 0), {}, /Invalid npm audit report or exit status/],
	[
		"expired exception",
		result(report({ picomatch: finding })),
		{ now: new Date("2026-12-18T00:00:00Z") },
		/Expired exception/,
	],
	["malformed JSON", result("{"), {}, /npm audit did not produce JSON/],
	["empty JSON", result(""), {}, /npm audit did not produce JSON/],
	["missing report fields", result("{}", 0), {}, /Invalid npm audit report/],
	[
		"npm network error",
		result(JSON.stringify({ error: { code: "ENETUNREACH" } })),
		{},
		/npm audit failed:.*ENETUNREACH/,
	],
	["unexpected npm exit", result(report({ picomatch: finding }), 2), {}, /npm audit execution failed: 2/],
	[
		"npm spawn failure",
		{ ...result("", null), error: new Error("spawn failed") },
		{},
		/npm audit execution failed: Error: spawn failed/,
	],
	["stale exception", result(report({}), 0), {}, /Stale exception.*GHSA-fc5q-39xc-vjpf/],
	[
		"unresolved transitive finding",
		result(report({ tool: { name: "tool", via: ["missing"], nodes: ["node_modules/tool"] } })),
		{},
		/Invalid npm audit finding: missing/,
	],
	[
		"transitive-only cycle",
		result(report({ tool: { name: "tool", via: ["tool"], nodes: ["node_modules/tool"] } })),
		{},
		/Cyclic/,
	],
	[
		"excepted mutual cycle",
		result(
			report({
				picomatch: { ...finding, via: ["tool", advisory] },
				tool: { name: "tool", via: ["picomatch"], nodes: ["node_modules/tool"] },
			}),
		),
		{},
		null,
	],
	[
		"unanchored mutual cycle alongside an excepted finding",
		result(
			report({
				picomatch: finding,
				one: { name: "one", via: ["two"], nodes: ["node_modules/one"] },
				two: { name: "two", via: ["one"], nodes: ["node_modules/two"] },
			}),
		),
		{},
		/Cyclic/,
	],
];
for (const [name, response, options, expected] of cases) {
	test(name, () => {
		/** @type {string[]} */
		const logs = [];
		/** @param {string} command */
		const run = (command) => (command === "git" ? result("package-lock.json\0", 0) : response);
		const invoke = () =>
			auditLockfiles({
				root: "/fixture",
				exceptions,
				now: new Date("2026-11-17T00:00:00Z"),
				run,
				log: (line) => logs.push(line),
				...options,
			});
		if (expected === null) {
			invoke();
			assert.match(logs.join("\n"), /Excepted GHSA-fc5q-39xc-vjpf.*picomatch.*node_modules\/picomatch/);
		} else {
			assert.throws(invoke, expected);
			if (name === "stale exception") assert.match(logs.join("\n"), /Stale exception.*GHSA-fc5q-39xc-vjpf/);
		}
	});
}

test("covers every discovered lock and resolves transitive findings without applying exceptions to tools", () => {
	/** @type {[string, string[]][]} */
	const calls = [];
	/** @type {string[]} */
	const logs = [];
	/** @param {string} command @param {string[]} args */
	const run = (command, args) => {
		calls.push([command, args]);
		if (command === "git") return result("package-lock.json\0examples/fixture/package-lock.json\0", 0);
		return args.includes("--workspaces=false")
			? result(report({}), 0)
			: result(
					report({
						picomatch: finding,
						tool: { name: "tool", via: ["picomatch"], nodes: ["node_modules/tool"] },
					}),
				);
	};
	auditLockfiles({ root: "/fixture", exceptions, run, now: new Date("2026-11-17"), log: (line) => logs.push(line) });
	assert.deepEqual(calls, [
		["git", ["ls-files", "-z", "--", "package-lock.json", "**/package-lock.json"]],
		["npm", ["audit", "--json", "--package-lock-only", "--audit-level=info", "--prefix", "."]],
		[
			"npm",
			[
				"audit",
				"--json",
				"--package-lock-only",
				"--audit-level=info",
				"--prefix",
				"examples/fixture",
				"--workspaces=false",
			],
		],
	]);
	assert.match(logs.join("\n"), /Audited 2 lockfiles/);
});

test("rejects wildcard exceptions and empty discovery", () => {
	assert.throws(() => auditLockfiles({ root: "/fixture", exceptions: { "*": exceptions[id] } }), /Invalid exception/);
	assert.throws(() => auditLockfiles({ root: "/fixture", exceptions: {}, run: () => result("", 0) }), /No tracked/);
});
