import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// Below Vitest's 5s default so a hung child is killed before the test deadline.
const CHILD_TIMEOUT_MS = 4_000;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];

// configureHttpDispatcher() caches the installed global fetch and the flood case
// may crash its process, so each scenario runs in a fresh Node child.
async function runFixture(fixture: string): Promise<string> {
	const env = { ...process.env };
	for (const key of PROXY_ENV_KEYS) {
		delete env[key];
		delete env[key.toLowerCase()];
	}
	const { stdout } = await execFileAsync(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))],
		{ env, timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
	);
	return stdout;
}

describe("http dispatcher undici upgrade compatibility", () => {
	it("decodes gzip and brotli JSON through undici.fetch and globalThis.fetch", async () => {
		await expect(runFixture("http-dispatcher-compression.ts")).resolves.toBe("compression-ok\n");
	});

	// GHSA-xjj6-f33q-929c, nredd/pi#10
	it("rejects more than 5 content-encodings with an early FIN without crashing", async () => {
		await expect(runFixture("http-dispatcher-content-encoding-flood.ts")).resolves.toBe("flood-rejected-ok\n");
	});
});
