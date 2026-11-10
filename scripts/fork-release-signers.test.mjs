import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/fork-release.yml", import.meta.url), "utf8"));
const verification = workflow.jobs.build.steps.find((step) => step.id === "target").run;
const signers = [...verification.matchAll(/'(nredd namespaces="git" ssh-ed25519 [A-Za-z0-9+/=]+)'/g)].map(
	(match) => match[1],
);

// Exercise the exact workflow policy shape without accessing an owner's private key.
test("fork release trusts exactly the two owner keys in Git's namespace", () => {
	assert.equal(signers.length, 2);
	assert.deepEqual(
		signers.map(
			(line) =>
				`SHA256:${createHash("sha256")
					.update(Buffer.from(line.split(" ")[3], "base64"))
					.digest("base64")
					.replace(/=+$/, "")}`,
		),
		["SHA256:YHzjQXY3SPl20zOMMOoNz8o4dk+eOZEi8FA+vS6nwFY", "SHA256:+16+g7/7VKDJ2svgiuGIbfPnPF9pKKSU/h51+K9iHdk"],
	);
	assert.match(
		verification,
		/git -c "gpg\.ssh\.allowedSignersFile=\$RUNNER_TEMP\/ssh\/allowed_signers" verify-tag "\$RELEASE_TAG"/,
	);
});

test("release tag verification accepts both signer slots and rejects an unknown key", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-release-signers-"));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
	const git = (...args) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", stdio: "pipe" });
	try {
		git("init");
		git("config", "user.name", "Release fixture");
		git("config", "user.email", "release@example.invalid");
		git("config", "gpg.format", "ssh");
		git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture");
		const keys = ["macbook", "mac-mini", "unknown"].map((name) => {
			const key = join(root, name);
			execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key], { env, stdio: "pipe" });
			return key;
		});
		const allowed = join(root, "allowed_signers");
		const policy = signers
			.map((line, index) => line.replace(/ssh-ed25519 .+$/, readFileSync(`${keys[index]}.pub`, "utf8").trim()))
			.join("\n");
		writeFileSync(allowed, `${policy}\n`);
		git("config", "gpg.ssh.allowedSignersFile", allowed);
		for (const [index, key] of keys.entries()) {
			const tag = `fixture-${index}`;
			git("-c", `user.signingkey=${key}`, "tag", "-s", "-m", tag, tag);
			const result = spawnSync("git", ["-C", root, "verify-tag", tag], { env, encoding: "utf8" });
			assert.equal(result.status, index < 2 ? 0 : 1, result.stderr);
			if (index < 2) assert.match(result.stderr, /Good "git" signature for nredd/);
		}
		writeFileSync(allowed, `${policy.replaceAll('namespaces="git"', 'namespaces="file"')}\n`);
		assert.throws(() => git("verify-tag", "fixture-1"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
