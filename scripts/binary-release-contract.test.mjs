import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	archiveName,
	createBuildIdentity,
	MEMORY,
	PLATFORMS,
	releaseAssetNames,
	sha256,
	verifyAssetNames,
	verifyRelease,
} from "./binary-release-contract.mjs";

// nredd/pi#43: publication must consume the exact bytes with successful real memory smoke.
/** @param {(root: string, receipts: Awaited<ReturnType<typeof verifyRelease>>, identity: Awaited<ReturnType<typeof createBuildIdentity>>) => Promise<void>} run */
async function fixture(run) {
	const workspace = await mkdtemp(join(tmpdir(), "pi-binary-contract-")),
		root = join(workspace, "draft-assets");
	await mkdir(root);
	try {
		for (const platform of PLATFORMS) {
			await writeFile(join(root, archiveName(platform)), platform);
			await mkdir(join(root, platform));
			await writeFile(
				join(root, platform, platform.startsWith("windows-") ? "pi.exe" : "pi"),
				`executable-${platform}`,
			);
		}
		const identity = await createBuildIdentity(root, "a".repeat(40), "v1.3.0", "1.3.14");
		for (const platform of PLATFORMS) await rm(join(root, platform), { recursive: true });
		for (const name of releaseAssetNames(identity.releaseTag)) {
			if (!name.startsWith("pi-") || !PLATFORMS.some((platform) => name === archiveName(platform)))
				await writeFile(join(root, name), "fixture");
		}
		await writeFile(join(root, "BUILD-IDENTITY.json"), JSON.stringify(identity));
		const receipts = PLATFORMS.map((platform) => ({
			schemaVersion: 1,
			sourceSha: identity.sourceSha,
			releaseTag: identity.releaseTag,
			platform,
			archiveSha256: identity.artifacts[platform].archiveSha256,
			binarySha256: identity.artifacts[platform].binarySha256,
			memory: { ...MEMORY, passed: true },
		}));
		await writeFile(join(root, "BINARY-SMOKE.json"), JSON.stringify(receipts));
		await run(root, receipts, identity);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}
/** @param {string} root */
const verify = (root) => verifyRelease(root, "a".repeat(40), "v1.3.0");
test("admits all and only the six tested source-bound binaries", () =>
	fixture(async (root) => {
		await verify(root);
	}));
for (const change of [
	"absent",
	"failed",
	"binary",
	"archive",
	"source",
	"tag",
	"version",
	"integrity",
	"duplicate",
	"schema",
]) {
	test(`rejects ${change} smoke receipts`, () =>
		fixture(async (root, receipts) => {
			const receipt = receipts[0];
			if (change === "absent") receipts.pop();
			if (change === "failed") receipt.memory.passed = false;
			if (change === "binary") receipt.binarySha256 = "c".repeat(64);
			if (change === "archive") receipt.archiveSha256 = "c".repeat(64);
			if (change === "source") receipt.sourceSha = "c".repeat(40);
			if (change === "tag") receipt.releaseTag = "v9.0.0";
			if (change === "version") receipt.memory.version = "9.0.0";
			if (change === "integrity") receipt.memory.integrity = "sha512-other";
			if (change === "duplicate") receipts[1] = receipt;
			if (change === "schema") receipt.schemaVersion = 2;
			await writeFile(join(root, "BINARY-SMOKE.json"), JSON.stringify(receipts));
			await assert.rejects(verify(root));
		}));
}
test("replacement archive cannot be blessed by regenerating build checksums", () =>
	fixture(async (root, _receipts, identity) => {
		await writeFile(join(root, archiveName(PLATFORMS[0])), "replacement untested bytes");
		await assert.rejects(verify(root));
		const updated = structuredClone(identity);
		updated.artifacts[PLATFORMS[0]].archiveSha256 = await sha256(join(root, archiveName(PLATFORMS[0])));
		await writeFile(join(root, "BUILD-IDENTITY.json"), JSON.stringify(updated));
		await assert.rejects(verify(root));
	}));
test("draft cannot replace bytes and forge matching smoke/build metadata", () =>
	fixture(async (root, receipts, identity) => {
		const trusted = join(root, "..", "trusted");
		await mkdir(trusted);
		for (const name of ["BUILD-IDENTITY.json", "BINARY-SMOKE.json"])
			await copyFile(join(root, name), join(trusted, name));
		await verifyRelease(root, identity.sourceSha, identity.releaseTag, trusted);
		await writeFile(join(root, archiveName(PLATFORMS[0])), "untested replacement");
		const changed = structuredClone(identity);
		changed.artifacts[PLATFORMS[0]].archiveSha256 = await sha256(join(root, archiveName(PLATFORMS[0])));
		receipts[0].archiveSha256 = changed.artifacts[PLATFORMS[0]].archiveSha256;
		await writeFile(join(root, "BUILD-IDENTITY.json"), JSON.stringify(changed));
		await writeFile(join(root, "BINARY-SMOKE.json"), JSON.stringify(receipts));
		await assert.rejects(
			verifyRelease(root, identity.sourceSha, identity.releaseTag, trusted),
			/substituted trusted evidence/,
		);
	}));
for (const name of ["pi-linux-riscv64.tar.gz", "unexpected.txt"]) {
	test(`rejects unlisted draft asset ${name}`, () =>
		fixture(async (root) => {
			await writeFile(join(root, name), "untested extra");
			await assert.rejects(verify(root), /asset/i);
		}));
}
test("requires the exact remote asset set, including deliberate nonbinary payloads", () => {
	const expected = releaseAssetNames("v1.3.0");
	verifyAssetNames([...expected].reverse(), "v1.3.0");
	for (const names of [
		expected.slice(1),
		[...expected, expected[0]],
		[...expected, "pi-linux-riscv64.tar.gz"],
		[...expected, "unexpected.txt"],
		[...expected.slice(1), "../pi-linux-x64.tar.gz"],
		[...expected.slice(1), "/pi-linux-x64.tar.gz"],
		[...expected.slice(1), "nested\\file"],
		[...expected.slice(1), "bad\nname"],
		[...expected.slice(1), null],
	]) {
		assert.throws(() => verifyAssetNames(names, "v1.3.0"), /asset names/);
	}
});
test("actual prepublication inventory CLI refuses remote extras, duplicates and unsafe names", () =>
	fixture(async (root) => {
		const inventory = join(root, "..", "remote-assets.json"),
			entry = join(root, "..", "gate-alias.mjs");
		await symlink(fileURLToPath(new URL("./binary-release-contract.mjs", import.meta.url)), entry, "file");
		/** @param {unknown[]} names */
		const invoke = async (names) => {
			await writeFile(inventory, JSON.stringify(names.map((name, id) => ({ id, name, size: 0 }))));
			return spawnSync(process.execPath, [entry, "assets", inventory, "v1.3.0"], { encoding: "utf8" });
		};
		const expected = releaseAssetNames("v1.3.0"),
			positive = await invoke(expected);
		assert.equal(positive.status, 0, positive.stderr);
		assert.match(positive.stdout, /Release asset-name admission passed/);
		for (const names of [
			[...expected, "pi-linux-riscv64.tar.gz"],
			[...expected, "unexpected.txt"],
			expected.slice(1),
			[...expected, expected[0]],
			[...expected.slice(1), "../unsafe"],
			[...expected.slice(1), null],
		]) {
			const negative = await invoke(names);
			assert.equal(negative.status, 1, negative.stdout);
			assert.match(negative.stderr, /Release asset names/);
		}
	}));
test("refuses nonregular allowlisted assets rather than following symlinks or directories", () =>
	fixture(async (root) => {
		const path = join(root, "pi-coding-agent-install-package.json"),
			target = join(root, "..", "outside.json");
		await writeFile(target, "fixture");
		await rm(path);
		await symlink(target, path, "file");
		await assert.rejects(verify(root), /not a regular file/);
		await rm(path);
		await mkdir(path);
		await assert.rejects(verify(root), /not a regular file/);
	}));
test("missing nonbinary metadata refuses an otherwise valid draft", () =>
	fixture(async (root) => {
		await rm(join(root, "pi-coding-agent-install-package-lock.json"));
		await assert.rejects(verify(root), /asset names/);
	}));
test("rejects malformed or mismatched build provenance", () =>
	fixture(async (root) => {
		const path = join(root, "BUILD-IDENTITY.json");
		const identity = JSON.parse(await readFile(path, "utf8"));
		identity.sourceSha = "c".repeat(40);
		await writeFile(path, JSON.stringify(identity));
		await assert.rejects(verify(root));
	}));
