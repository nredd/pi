import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type TestContext, test } from "node:test";
import {
	DefaultPackageManager,
	type PackageManagerOptions,
	SettingsManager,
} from "../packages/coding-agent/src/index.ts";

/** Real file-backed settings and discovery; no private method replacement. nredd/pi#14. */
function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const cwd = join(root, "project");
	const agentDir = join(homeDir, ".pi", "agent");
	for (const dir of [agentDir, join(cwd, ".pi"), join(cwd, ".git")]) mkdirSync(dir, { recursive: true });
	const put = (path: string, content: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return path;
	};
	const settings = (global: object = {}, project: object = {}, projectTrusted = true) => {
		put(join(agentDir, "settings.json"), JSON.stringify(global));
		put(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
		return SettingsManager.create(cwd, agentDir, { projectTrusted });
	};
	const manager = (
		settingsManager: SettingsManager,
		projectSkillPathFilter?: PackageManagerOptions["projectSkillPathFilter"],
	) => new DefaultPackageManager({ cwd, agentDir, homeDir, settingsManager, projectSkillPathFilter });
	const pkg = join(root, "package");
	const packageSkill = put(join(pkg, "skills", "review", "SKILL.md"), "# Package review");
	put(join(pkg, "package.json"), JSON.stringify({ pi: { skills: ["skills"] } }));
	const alias = join(cwd, ".pi", "skills", "review");
	const linkProject = (target: string) => {
		mkdirSync(dirname(alias), { recursive: true });
		symlinkSync(target, alias, "dir");
		return join(alias, "SKILL.md");
	};
	return { root, homeDir, cwd, agentDir, put, settings, manager, pkg, packageSkill, linkProject };
}

for (const sourceForm of ["relative", "absolute"] as const) {
	for (const allowed of [false, true]) {
		test(`${sourceForm} project package ${allowed ? "allowlist" : "exclusion"} survives rejected canonical alias`, async (t) => {
			const f = fixture(t);
			const source = sourceForm === "relative" ? relative(join(f.cwd, ".pi"), f.pkg) : f.pkg;
			const settings = f.settings(
				{ packages: [f.pkg] },
				{ packages: [{ source, skills: allowed ? ["skills/review"] : [] }] },
			);
			const control = (await f.manager(settings).resolve(async () => "skip")).skills;
			assert.equal(control.length, 1);
			assert.equal(control[0].enabled, allowed);
			assert.equal(control[0].metadata.scope, "project");
			assert.equal(control[0].metadata.origin, "package");
			const alias = f.linkProject(dirname(f.packageSkill));
			const seen: string[] = [];
			const result = await f
				.manager(settings, (path) => {
					seen.push(path);
					return path !== alias;
				})
				.resolve(async () => "skip");
			assert.deepEqual(seen, [alias]);
			assert.deepEqual(result.skills, control);
			assert.equal(result.skills[0].metadata.source, source);
		});
	}
}

test("rejecting a project alias reveals the injected-home user candidate", async (t) => {
	const f = fixture(t);
	const user = f.put(join(f.homeDir, ".agents", "skills", "review", "SKILL.md"), "# User review");
	const alias = f.linkProject(dirname(user));
	const settings = f.settings();
	const result = await f.manager(settings, (path) => path !== alias).resolve();
	assert.equal(result.skills.length, 1);
	assert.equal(result.skills[0].path, user);
	assert.equal(result.skills[0].metadata.scope, "user");
	assert.equal(result.skills[0].enabled, true);
});

test("omission and acceptance retain project canonical precedence", async (t) => {
	const f = fixture(t);
	const alias = f.linkProject(dirname(f.packageSkill));
	const settings = f.settings({ packages: [f.pkg] });
	const omitted = await f.manager(settings).resolve();
	const accepted = await f.manager(settings, () => true).resolve();
	assert.deepEqual(accepted, omitted);
	assert.equal(accepted.skills.length, 1);
	assert.equal(accepted.skills[0].path, alias);
	assert.equal(accepted.skills[0].metadata.scope, "project");
	assert.equal(accepted.skills[0].metadata.origin, "top-level");
});

test("disabled project candidates are vetoed too, while acceptance cannot enable them", async (t) => {
	const f = fixture(t);
	const alias = f.linkProject(dirname(f.packageSkill));
	const settings = f.settings({ packages: [f.pkg] }, { skills: ["-skills/review"] });
	const seen: string[] = [];
	const accepted = await f
		.manager(settings, (path) => {
			seen.push(path);
			return true;
		})
		.resolve();
	assert.deepEqual(seen, [alias]);
	assert.equal(accepted.skills[0].path, alias);
	assert.equal(accepted.skills[0].enabled, false);
	const rejected = await f.manager(settings, () => false).resolve();
	assert.equal(rejected.skills[0].path, f.packageSkill);
	assert.equal(rejected.skills[0].enabled, true);
});

test("only project top-level skills, both explicit and automatic, reach the callback", async (t) => {
	const f = fixture(t);
	const automatic = f.put(join(f.cwd, ".pi", "skills", "auto", "SKILL.md"), "# Automatic");
	const agents = f.put(join(f.cwd, ".agents", "skills", "agent", "SKILL.md"), "# Agents");
	const explicit = f.put(join(f.root, "explicit.md"), "# Explicit");
	const user = f.put(join(f.agentDir, "skills", "user", "SKILL.md"), "# User");
	const extension = f.put(join(f.cwd, ".pi", "extensions", "index.ts"), "export default () => {};");
	const prompt = f.put(join(f.cwd, ".pi", "prompts", "prompt.md"), "Prompt");
	const theme = f.put(join(f.cwd, ".pi", "themes", "theme.json"), "{}");
	const seen: string[] = [];
	const result = await f
		.manager(f.settings({ packages: [f.pkg] }, { skills: [explicit] }), (path) => {
			seen.push(path);
			return false;
		})
		.resolve();
	assert.deepEqual(seen.sort(), [automatic, agents, explicit].sort());
	assert.deepEqual(result.skills.map((entry) => entry.path).sort(), [user, f.packageSkill].sort());
	assert.deepEqual(
		result.extensions.map((entry) => entry.path),
		[extension],
	);
	assert.deepEqual(
		result.prompts.map((entry) => entry.path),
		[prompt],
	);
	assert.deepEqual(
		result.themes.map((entry) => entry.path),
		[theme],
	);
});

test("autoload false project deltas and ordered modifiers keep native package decisions", async (t) => {
	const f = fixture(t);
	const other = f.put(join(f.pkg, "skills", "other", "SKILL.md"), "# Other");
	const untouched = f.put(join(f.pkg, "skills", "untouched", "SKILL.md"), "# Untouched");
	const alias = f.linkProject(dirname(f.packageSkill));
	const source = relative(join(f.cwd, ".pi"), f.pkg);
	const settings = f.settings(
		{ packages: [f.pkg] },
		{
			packages: [{ source, autoload: false, skills: ["!skills/*", "+skills/review", "-skills/review"] }],
		},
	);
	const result = await f.manager(settings, (path) => path !== alias).resolve();
	assert.deepEqual(Object.fromEntries(result.skills.map((entry) => [entry.path, entry.enabled])), {
		[other]: false,
		[f.packageSkill]: false,
		[untouched]: false,
	});
	assert.ok(result.skills.every((entry) => entry.metadata.scope === "project" && entry.metadata.origin === "package"));
	const positive = f.settings({}, { packages: [{ source, autoload: false, skills: ["+skills/review"] }] });
	const selected = await f.manager(positive, () => false).resolve();
	assert.deepEqual(
		selected.skills.map((entry) => [entry.path, entry.enabled]),
		[[f.packageSkill, true]],
	);
	const delta = f.settings(
		{ packages: [f.pkg] },
		{ packages: [{ source, autoload: false, skills: ["-skills/review"] }] },
	);
	const inherited = await f.manager(delta, () => false).resolve();
	assert.deepEqual(
		Object.fromEntries(inherited.skills.map((entry) => [entry.path, [entry.enabled, entry.metadata.scope]])),
		{
			[f.packageSkill]: [false, "project"],
			[other]: [true, "user"],
			[untouched]: [true, "user"],
		},
	);
});

test("an accepting callback cannot admit untrusted project settings or automatic discovery", async (t) => {
	const f = fixture(t);
	f.linkProject(dirname(f.packageSkill));
	const settings = f.settings({ packages: [f.pkg] }, { packages: [{ source: f.pkg, skills: [] }] }, false);
	let called = false;
	const manager = f.manager(settings, () => {
		called = true;
		return true;
	});
	const result = await manager.resolve();
	assert.equal(called, false);
	assert.equal(result.skills.length, 1);
	assert.equal(result.skills[0].path, f.packageSkill);
	assert.equal(result.skills[0].enabled, true);
	assert.equal(result.skills[0].metadata.scope, "user");
	assert.throws(() => manager.getInstalledPath(f.pkg, "project"), /Project is not trusted/);
});

test("missing-source inspection skips installation before admission", async (t) => {
	// Offline mode skips even the onMissing callback. Exercise the explicit inspect-only path.
	const offline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "0";
	t.after(() => {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	});
	const f = fixture(t);
	const source = "git:github.com/pi-admission-missing/never-installed";
	const seen: string[] = [];
	let called = false;
	const manager = f.manager(f.settings({}, { packages: [source] }), () => {
		called = true;
		return true;
	});
	const result = await manager.resolve(async (missing) => {
		seen.push(missing);
		return "skip";
	});
	assert.deepEqual(seen, [source]);
	assert.deepEqual(result, { extensions: [], skills: [], prompts: [], themes: [] });
	assert.equal(called, false);
	assert.equal(existsSync(join(f.cwd, ".pi", "git")), false);
});

test("callback exceptions reject resolution instead of accepting or returning partial candidates", async (t) => {
	const f = fixture(t);
	f.linkProject(dirname(f.packageSkill));
	const failure = new Error("admission failed");
	const manager = f.manager(f.settings({ packages: [f.pkg] }), () => {
		throw failure;
	});
	await assert.rejects(manager.resolve(), (error) => error === failure);
});
