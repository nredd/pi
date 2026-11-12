import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
// nredd/pi#43: keep byte admission at both release-write boundaries, not merely a smoke job name.
test("records candidate identity and requires memory smoke on every published architecture", () => {
	assert.match(workflow, /binary-release-contract\.mjs record/);
	assert.match(workflow, /smoke-test-memory-binary\.mjs/);
	for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"]) {
		assert.ok(workflow.includes(`platform: ${platform}`), platform);
	}
	assert.match(workflow, /name: binary-smoke-\$\{\{ matrix.platform \}\}/);
	assert.match(workflow, /bun-version: 1\.3\.14/);
});
test("verifies tested bytes before staging and again from draft assets before publication", () => {
	const stage = workflow.slice(workflow.indexOf("  stage-github-release:"), workflow.indexOf("  # The pi-env daemon"));
	const publish = workflow.slice(
		workflow.indexOf("  publish-github-release:"),
		workflow.indexOf("  cleanup-draft-github-release:"),
	);
	assert.ok(stage.indexOf("binary-release-contract.mjs verify") < stage.indexOf("gh release create"));
	assert.ok(stage.includes("binary-release-contract.mjs verify"));
	assert.ok(publish.includes("gh release download"));
	assert.ok(publish.indexOf("binary-release-contract.mjs verify") < publish.indexOf("gh release edit"));
	assert.ok(publish.includes("binary-release-contract.mjs verify"));
	const names = publish.indexOf("binary-release-contract.mjs assets draft-asset-identity.json");
	assert.ok(names >= 0 && names < publish.indexOf("gh release download"));
	const inventoryRecheck = publish.indexOf("cmp draft-asset-identity.json final-asset-identity.json");
	assert.ok(
		inventoryRecheck > publish.indexOf("sha256sum -c SHA256SUMS") &&
			inventoryRecheck < publish.indexOf("gh release edit"),
	);
	assert.ok(stage.includes("mv release-assets/RELEASE_NOTES.md RELEASE_NOTES.md"));
	assert.ok(stage.includes("--notes-file ../RELEASE_NOTES.md"));
});
