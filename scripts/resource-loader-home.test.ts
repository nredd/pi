import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager } from "../packages/coding-agent/src/core/package-manager.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";

// nredd/pi#12 (prerequisite for nredd/pi-harness#179): exercise real discovery, not a replacement package manager.
test("an injected home redirects automatic and explicit resources without touching ambient user roots", async (t) => {
	if (!process.env.PI_HOME_CANARY_CHILD) {
		const ambientHome = fs.mkdtempSync(join(tmpdir(), "pi-ambient-decoy-"));
		t.after(() => fs.rmSync(ambientHome, { recursive: true, force: true }));
		const decoy = join(ambientHome, ".agents", "skills", "decoy");
		fs.mkdirSync(decoy, { recursive: true });
		fs.writeFileSync(join(decoy, "SKILL.md"), "---\nname: decoy\ndescription: ambient decoy\n---\nMust not scan.");
		const file = fileURLToPath(import.meta.url);
		const args = process.versions.bun
			? ["test", file]
			: [
					"--import",
					fileURLToPath(new URL("../packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url)),
					"--test",
					file,
				];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: ambientHome,
			USERPROFILE: ambientHome,
			PI_HOME_CANARY_CHILD: "1",
			PI_OFFLINE: "1",
		};
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, args, {
			env,
			encoding: "utf8",
			timeout: 30000,
		});
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		return;
	}
	const root = fs.mkdtempSync(join(tmpdir(), "pi-loader-home-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const homeDir = join(root, "private-home");
	const agentDir = join(homeDir, ".pi", "agent");
	const cwd = join(root, "project");
	const skillPath = join(homeDir, ".agents", "skills", "private-skill", "SKILL.md");
	const packagePath = join(homeDir, "package");
	for (const path of [agentDir, cwd, dirname(skillPath), packagePath]) fs.mkdirSync(path, { recursive: true });
	fs.mkdirSync(join(cwd, ".git")); // Bound ancestor project discovery to the fixture.
	fs.writeFileSync(skillPath, "---\nname: private-skill\ndescription: private home\n---\nPrivate skill.");
	fs.symlinkSync(dirname(skillPath), join(homeDir, ".agents", "skills", "linked-skill"), "dir");
	fs.writeFileSync(join(homeDir, "explicit.md"), "---\nname: explicit\ndescription: explicit\n---\nExplicit skill.");
	fs.writeFileSync(
		join(homeDir, "additional.md"),
		"---\nname: additional\ndescription: additional\n---\nAdditional skill.",
	);
	fs.writeFileSync(join(homeDir, "extended.md"), "---\nname: extended\ndescription: extended\n---\nExtended skill.");
	fs.writeFileSync(join(homeDir, "prompt.md"), "Private prompt.");
	fs.copyFileSync(
		new URL("../packages/coding-agent/src/modes/interactive/theme/dark.json", import.meta.url),
		join(homeDir, "theme.json"),
	);
	fs.writeFileSync(join(homeDir, "extension.ts"), "export default function () {}");
	fs.writeFileSync(join(packagePath, "package.json"), JSON.stringify({ pi: { prompts: ["kept.md", "hidden.md"] } }));
	fs.writeFileSync(join(packagePath, "kept.md"), "Kept package prompt.");
	fs.writeFileSync(join(packagePath, "hidden.md"), "Filtered package prompt.");
	fs.mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
	fs.writeFileSync(join(cwd, ".pi", "prompts", "kept.md"), "Project wins.");

	const ambientHome = process.env.HOME || process.env.USERPROFILE;
	assert.ok(ambientHome, "test requires an ambient home distinct from private-home");
	const ambientRoots = [join(ambientHome, ".agents"), join(ambientHome, ".pi", "agent")];
	const forbiddenReads: string[] = [];
	// Discovery catches some filesystem errors. Record attempts too, so swallowed failures cannot pass.
	for (const method of ["existsSync", "readdirSync", "readFileSync", "statSync", "realpathSync"] as const) {
		const original = fs[method];
		t.mock.method(fs, method, (...args: unknown[]) => {
			const path = args[0];
			if (
				typeof path === "string" &&
				ambientRoots.some((base) => path === base || path.startsWith(`${base}${sep}`))
			) {
				forbiddenReads.push(path);
				throw new Error(`Ambient resource access: ${path}`);
			}
			return Reflect.apply(original, fs, args);
		});
	}
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const settingsManager = SettingsManager.inMemory({
		packages: [{ source: "~/package", prompts: ["kept.md"], extensions: [], skills: [], themes: [] }],
		skills: ["~/explicit.md"],
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: "~/.pi/agent",
		homeDir,
		settingsManager,
		additionalExtensionPaths: ["~/extension.ts"],
		additionalSkillPaths: ["~/additional.md"],
		additionalPromptTemplatePaths: ["~/prompt.md"],
		additionalThemePaths: ["~/theme.json"],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getExtensions().extensions.length, 1);
	assert.deepEqual(
		loader
			.getSkills()
			.skills.map((skill) => skill.name)
			.sort(),
		["additional", "explicit", "private-skill"],
	);
	assert.equal(loader.getThemes().themes.length, 1);
	loader.extendResources({
		skillPaths: [
			{
				path: "~/extended.md",
				metadata: { source: "local", scope: "temporary", origin: "top-level", baseDir: "~" },
			},
		],
	});
	assert.equal(loader.getSkills().skills.find((skill) => skill.name === "extended")?.sourceInfo.baseDir, homeDir);
	assert.equal(loader.getSkills().skills.find((skill) => skill.name === "private-skill")?.sourceInfo.scope, "user");
	assert.deepEqual(
		loader
			.getPrompts()
			.prompts.map((prompt) => prompt.name)
			.sort(),
		["kept", "prompt"],
	);
	assert.equal(loader.getPrompts().prompts.find((prompt) => prompt.name === "kept")?.content, "Project wins.");
	await loader.reload();
	const manager = new DefaultPackageManager({
		cwd: "~",
		agentDir: "~/.pi/agent",
		homeDir,
		settingsManager: SettingsManager.inMemory({ packages: ["~/package"] }),
	});
	assert.equal(manager.getInstalledPath("~/package", "user"), packagePath);
	assert.equal(manager.addSourceToSettings("~/package"), true);
	assert.equal(manager.removeSourceFromSettings("~/package"), true);
	assert.equal((await manager.resolveExtensionSources(["./package"], { temporary: true })).prompts.length, 2);
	assert.deepEqual(forbiddenReads, []);
	assert.equal(process.env.HOME || process.env.USERPROFILE, ambientHome);

	settingsManager.setProjectTrusted(false);
	await loader.reload();
	assert.equal(loader.getPrompts().prompts.find((prompt) => prompt.name === "kept")?.content, "Kept package prompt.");
	assert.deepEqual(forbiddenReads, []);

	const suppressed = new DefaultResourceLoader({ cwd, agentDir, homeDir, noSkills: true, settingsManager });
	await suppressed.reload();
	assert.deepEqual(suppressed.getSkills().skills, []);
	assert.deepEqual(forbiddenReads, []);

	const missing = new DefaultResourceLoader({
		cwd,
		agentDir,
		homeDir,
		settingsManager: SettingsManager.inMemory(),
		additionalSkillPaths: ["~/missing.md"],
	});
	await missing.reload();
	assert.ok(missing.getSkills().diagnostics.some((diagnostic) => diagnostic.path === resolve(homeDir, "missing.md")));
	assert.deepEqual(forbiddenReads, []);

	// Omission must retain normal discovery. HOME is a disposable decoy, never the caller's home.
	t.mock.restoreAll();
	syncBuiltinESMExports();
	const defaultLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
	await defaultLoader.reload();
	assert.ok(defaultLoader.getSkills().skills.some((skill) => skill.name === "decoy"));
});
