#!/usr/bin/env node
/** Bind binary publication to successful memory smoke of the same build, source and archive bytes. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{schemaVersion: number, sourceSha: string, releaseTag: string}} Identity */
/** @typedef {{archiveSha256: string, binarySha256: string}} Digests */
/** @typedef {Identity & {bunVersion: string, artifacts: Record<string, Digests>}} BuildIdentity */
/** @typedef {Identity & Digests & {platform: string, memory: {name: string, version: string, url: string, integrity: string, passed: boolean}}} SmokeReceipt */

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];
export const MEMORY = Object.freeze({
	name: "pi-memory",
	version: "0.4.2",
	url: "https://registry.npmjs.org/pi-memory/-/pi-memory-0.4.2.tgz",
	integrity: "sha512-voH+1MalADyVN23p79g4atdtPxzr1bDcfk1y0uCJL0xfodiSzNA5V5CcmODBTtHlrQzDT+AgasYPlgNWg8YPRQ==",
});
/** @param {string} platform */
export function archiveName(platform) {
	if (!PLATFORMS.includes(platform)) throw new Error(`Unknown binary platform: ${platform}`);
	return `pi-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`;
}
/** Stream large binary artifacts instead of retaining them in memory.
 * @param {string} path
 */
export async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
/** @param {Identity | undefined} value @param {string} sourceSha @param {string} releaseTag */
function requireIdentity(value, sourceSha, releaseTag) {
	if (
		value?.schemaVersion !== 1 ||
		!/^[a-f0-9]{40}$/.test(sourceSha) ||
		!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-nredd\.[0-9]+)?$/.test(releaseTag) ||
		value.sourceSha !== sourceSha ||
		value.releaseTag !== releaseTag
	) {
		throw new Error("Binary release source/tag/schema identity mismatch");
	}
}
/** Record the build output once, before any smoke or staging, including extracted executable digests.
 * @param {string} directory @param {string} sourceSha @param {string} releaseTag @param {string} bunVersion
 * @returns {Promise<BuildIdentity>}
 */
export async function createBuildIdentity(directory, sourceSha, releaseTag, bunVersion) {
	/** @type {BuildIdentity} */
	const identity = { schemaVersion: 1, sourceSha, releaseTag, bunVersion, artifacts: {} };
	requireIdentity(identity, sourceSha, releaseTag);
	if (!/^\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(bunVersion)) throw new Error("Missing build compiler identity");
	for (const platform of PLATFORMS) {
		identity.artifacts[platform] = {
			archiveSha256: await sha256(join(directory, archiveName(platform))),
			binarySha256: await sha256(join(directory, platform, platform.startsWith("windows-") ? "pi.exe" : "pi")),
		};
	}
	return identity;
}
/** Read original build provenance before executing a candidate or admitting a release.
 * @param {string} directory @param {string} sourceSha @param {string} releaseTag
 * @returns {Promise<BuildIdentity>}
 */
export async function readBuildIdentity(directory, sourceSha, releaseTag) {
	const build = JSON.parse(await readFile(join(directory, "BUILD-IDENTITY.json"), "utf8"));
	requireIdentity(build, sourceSha, releaseTag);
	if (typeof build.bunVersion !== "string" || !/^\d+\.\d+\.\d+(?:\+[^\s]+)?$/.test(build.bunVersion))
		throw new Error("Missing build compiler identity");
	if (
		Object.keys(build.artifacts ?? {})
			.sort()
			.join() !== [...PLATFORMS].sort().join()
	)
		throw new Error("Incomplete build architecture matrix");
	return build;
}
/** Fail closed if any architecture, smoke verdict, source identity or tested digest is absent or different.
 * @param {string} directory @param {string} sourceSha @param {string} releaseTag @param {string} [trustedDirectory]
 * @returns {Promise<SmokeReceipt[]>}
 */
export async function verifyRelease(directory, sourceSha, releaseTag, trustedDirectory) {
	if (trustedDirectory) {
		for (const name of ["BUILD-IDENTITY.json", "BINARY-SMOKE.json"]) {
			if ((await sha256(join(directory, name))) !== (await sha256(join(trustedDirectory, name))))
				throw new Error(`Draft substituted trusted evidence: ${name}`);
		}
	}
	const build = await readBuildIdentity(directory, sourceSha, releaseTag);
	const receipts = JSON.parse(await readFile(join(directory, "BINARY-SMOKE.json"), "utf8"));
	if (
		!Array.isArray(receipts) ||
		receipts.length !== PLATFORMS.length ||
		new Set(receipts.map((row) => row.platform)).size !== PLATFORMS.length
	)
		throw new Error("Incomplete or duplicate binary smoke matrix");
	for (const platform of PLATFORMS) {
		const receipt = receipts.find((row) => row.platform === platform);
		requireIdentity(receipt, sourceSha, releaseTag);
		const expected = build.artifacts[platform];
		if (
			!/^[a-f0-9]{64}$/.test(expected.binarySha256) ||
			receipt.binarySha256 !== expected.binarySha256 ||
			receipt.archiveSha256 !== expected.archiveSha256 ||
			(await sha256(join(directory, archiveName(platform)))) !== receipt.archiveSha256
		)
			throw new Error(`Untested or replaced binary: ${platform}`);
		if (
			receipt.memory?.passed !== true ||
			Object.entries(MEMORY).some(([key, value]) => receipt.memory[key] !== value)
		)
			throw new Error(`Missing pinned pi-memory smoke: ${platform}`);
	}
	return receipts;
}
async function main() {
	const [command, directory, sourceSha, releaseTag, extra] = process.argv.slice(2);
	if (command === "record" && extra) {
		const identity = await createBuildIdentity(resolve(directory), sourceSha, releaseTag, extra);
		await writeFile(join(directory, "BUILD-IDENTITY.json"), `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx" });
	} else if (command === "collect" && extra) {
		const receipts = await Promise.all(
			PLATFORMS.map(async (platform) => JSON.parse(await readFile(join(extra, `smoke-${platform}.json`), "utf8"))),
		);
		await writeFile(join(directory, "BINARY-SMOKE.json"), `${JSON.stringify(receipts, null, 2)}\n`, { flag: "wx" });
	} else if (command === "verify" && directory && sourceSha && releaseTag) {
		await verifyRelease(resolve(directory), sourceSha, releaseTag, extra);
		console.log("Binary release tested-byte admission passed");
	} else
		throw new Error(
			"Usage: binary-release-contract.mjs record|collect|verify <directory> <source-sha> <release-tag> [bun-version|receipt-dir|trusted-dir]",
		);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
