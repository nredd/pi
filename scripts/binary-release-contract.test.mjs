import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveName, createBuildIdentity, MEMORY, PLATFORMS, verifyRelease } from "./binary-release-contract.mjs";

// nredd/pi#43: publication must consume the exact bytes with successful real memory smoke.
/** @param {(root: string, receipts: Awaited<ReturnType<typeof verifyRelease>>, identity: Awaited<ReturnType<typeof createBuildIdentity>>) => Promise<void>} run */
async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "pi-binary-contract-"));
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
		await rm(root, { recursive: true, force: true });
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
		const updated = await createBuildIdentity(root, identity.sourceSha, identity.releaseTag, identity.bunVersion);
		await writeFile(join(root, "BUILD-IDENTITY.json"), JSON.stringify(updated));
		await assert.rejects(verify(root));
	}));
test("draft cannot replace bytes and forge matching smoke/build metadata", () =>
	fixture(async (root, receipts, identity) => {
		const trusted = join(root, "trusted");
		await mkdir(trusted);
		for (const name of ["BUILD-IDENTITY.json", "BINARY-SMOKE.json"])
			await copyFile(join(root, name), join(trusted, name));
		await verifyRelease(root, identity.sourceSha, identity.releaseTag, trusted);
		await writeFile(join(root, archiveName(PLATFORMS[0])), "untested replacement");
		const changed = await createBuildIdentity(root, identity.sourceSha, identity.releaseTag, identity.bunVersion);
		receipts[0].archiveSha256 = changed.artifacts[PLATFORMS[0]].archiveSha256;
		await writeFile(join(root, "BUILD-IDENTITY.json"), JSON.stringify(changed));
		await writeFile(join(root, "BINARY-SMOKE.json"), JSON.stringify(receipts));
		await assert.rejects(
			verifyRelease(root, identity.sourceSha, identity.releaseTag, trusted),
			/substituted trusted evidence/,
		);
	}));
test("rejects malformed or mismatched build provenance", () =>
	fixture(async (root) => {
		const path = join(root, "BUILD-IDENTITY.json");
		const identity = JSON.parse(await readFile(path, "utf8"));
		identity.sourceSha = "c".repeat(40);
		await writeFile(path, JSON.stringify(identity));
		await assert.rejects(verify(root));
	}));
