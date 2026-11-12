#!/usr/bin/env node
/** Exercise the real pinned pi-memory extension through Pi's CLI and loopback model API, without user state. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { archiveName, MEMORY, readBuildIdentity, sha256 } from "./binary-release-contract.mjs";

const MARKER = "PI_MEMORY_BINARY_SMOKE_OK";
/** Bounded child execution with an explicit isolated environment; never inherit provider credentials.
 * @param {string} command @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function run(command, args, cwd, env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "",
			stderr = "";
		/** @type {Error | undefined} */
		let failure;
		const timer = setTimeout(() => {
			failure = new Error("Memory smoke child timed out");
			child.kill("SIGKILL");
		}, 60_000);
		/** @type {[NodeJS.ReadableStream, (text: string) => void][]} */
		const outputs = [
			[
				child.stdout,
				(text) => {
					stdout += text;
				},
			],
			[
				child.stderr,
				(text) => {
					stderr += text;
				},
			],
		];
		for (const [stream, append] of outputs) {
			stream.on("data", (data) => {
				if (stdout.length + stderr.length + data.length > 1024 * 1024) {
					failure = new Error("Memory smoke output limit");
					child.kill("SIGKILL");
				} else append(data.toString());
			});
		}
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (failure || code !== 0) reject(failure ?? new Error(`Memory smoke child failed (${code})\n${stderr}`));
			else resolveRun({ stdout, stderr });
		});
	});
}
/** Only process-launch infrastructure survives; HOME, auth, npm config and Pi state are disposable.
 * @param {string} root
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedEnvironment(root) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"].includes(key),
		),
	);
	return {
		...env,
		HOME: root,
		USERPROFILE: root,
		TMPDIR: root,
		TMP: root,
		TEMP: root,
		XDG_CONFIG_HOME: root,
		XDG_CACHE_HOME: root,
		XDG_DATA_HOME: root,
		XDG_STATE_HOME: root,
		PI_CODING_AGENT_DIR: root,
		PI_MEMORY_DIR: join(root, "memory"),
		PI_MEMORY_EXIT_SUMMARY: "0",
		PI_MEMORY_NO_SEARCH: "1",
		PI_OFFLINE: "1",
		npm_config_userconfig: join(root, "npm-user"),
		npm_config_globalconfig: join(root, "npm-global"),
		npm_config_cache: join(root, "npm-cache"),
	};
}
/** Extract the authentic peer-only package after checking immutable SRI; run no lifecycle scripts.
 * @param {string} root @param {NodeJS.ProcessEnv} env
 */
export async function installMemory(root, env) {
	const response = await fetch(MEMORY.url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
	if (!response.ok) throw new Error(`Memory tarball HTTP ${response.status}`);
	if (!response.body) throw new Error("Empty memory tarball response");
	const reader = response.body.getReader(),
		chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 2 * 1024 * 1024) throw new Error("Memory tarball exceeds size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = Buffer.concat(chunks);
	if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== MEMORY.integrity)
		throw new Error("Memory tarball integrity mismatch");
	const tarball = join(root, "pi-memory.tgz");
	await writeFile(tarball, bytes);
	await run("tar", ["-xf", tarball, "-C", root], root, env);
	const memory = join(root, "package");
	const manifest = JSON.parse(await readFile(join(memory, "package.json"), "utf8"));
	if (manifest.name !== MEMORY.name || manifest.version !== MEMORY.version)
		throw new Error("Installed memory identity mismatch");
	return join(memory, "index.ts");
}
/** Require real write/read tool results, not just registration or an import without error.
 * @param {string} binary @param {string} memory @param {string} root @param {NodeJS.ProcessEnv} env
 */
export async function exerciseMemory(binary, memory, root, env) {
	let requests = 0,
		failure;
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions")
				throw new Error("Unexpected smoke API request");
			let body = "";
			for await (const chunk of request) {
				body += chunk;
				if (body.length > 1024 * 1024) throw new Error("Smoke request too large");
			}
			/** @type {{tools?: {function?: {name: string}}[], messages: {role: string, content: unknown}[]}} */
			const payload = JSON.parse(body);
			requests++;
			if (requests > 3) throw new Error("Unexpected extra model request");
			for (const name of ["memory_write", "memory_read"])
				if (!payload.tools?.some((tool) => tool.function?.name === name))
					throw new Error(`Missing real tool: ${name}`);
			const tools = payload.messages.filter((message) => message.role === "tool");
			if (requests === 2 && (!tools.length || /error/i.test(JSON.stringify(tools.at(-1)?.content))))
				throw new Error("Memory write did not succeed");
			if (requests === 3 && !JSON.stringify(tools.at(-1)?.content).includes(MARKER))
				throw new Error("Memory read did not return written content");
			const name = requests === 1 ? "memory_write" : "memory_read";
			const delta =
				requests === 3
					? { role: "assistant", content: MARKER }
					: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `memory-${requests}`,
									type: "function",
									function: {
										name,
										arguments: JSON.stringify(
											requests === 1 ? { target: "long_term", content: MARKER } : { target: "long_term" },
										),
									},
								},
							],
						};
			/** @param {Record<string, unknown>} value @param {string | null} finish */
			const chunk = (value, finish) => ({
				id: `memory-${requests}`,
				object: "chat.completion.chunk",
				created: 0,
				model: "memory-smoke",
				choices: [{ index: 0, delta: value, finish_reason: finish }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			});
			response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			response.end(
				`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, requests === 3 ? "stop" : "tool_calls"))}\n\ndata: [DONE]\n\n`,
			);
		} catch (error) {
			failure = error;
			response.writeHead(500).end();
		}
	});
	try {
		await new Promise((yes, no) => {
			server.once("error", no);
			server.listen(0, "127.0.0.1", () => yes(undefined));
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No loopback smoke listener");
		await writeFile(join(root, "auth.json"), "{}");
		await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [], quietStartup: true }));
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					"memory-smoke": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "synthetic-smoke",
						models: [{ id: "memory-smoke", contextWindow: 32768, maxTokens: 1024 }],
					},
				},
			}),
		);
		const args = [
			"--provider",
			"memory-smoke",
			"--model",
			"memory-smoke",
			"--tools",
			"memory_write,memory_read",
			"-e",
			memory,
			"--no-extensions",
			"--print",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"Exercise memory write and read.",
		];
		const js = extname(binary) === ".js";
		const result = await run(js ? process.execPath : binary, js ? [binary, ...args] : args, root, env);
		if (failure) throw failure;
		if (
			requests !== 3 ||
			result.stdout.trim() !== MARKER ||
			result.stderr.trim() ||
			!(await readFile(join(root, "memory", "MEMORY.md"), "utf8")).includes(MARKER)
		)
			throw new Error(`Memory smoke failed (${requests} requests)\n${result.stdout}\n${result.stderr}`);
	} finally {
		server.closeAllConnections();
		await new Promise((yes) => server.close(yes));
	}
}
async function main() {
	// Developer-only real CLI proof emits no release receipt and cannot admit an archive.
	if (process.argv[2] === "--cli" && process.argv.length === 4) {
		const root = await mkdtemp(join(tmpdir(), "pi-memory-cli-"));
		try {
			const env = isolatedEnvironment(root),
				memory = await installMemory(root, env);
			await exerciseMemory(resolve(process.argv[3]), memory, root, env);
			console.log(`Developer CLI: real pi-memory ${MEMORY.version} write/read passed (no release receipt)`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		return;
	}
	const [directoryArg, platform, sourceSha, releaseTag, output] = process.argv.slice(2);
	if (!output || process.argv.length !== 7)
		throw new Error(
			"Usage: node scripts/smoke-test-memory-binary.mjs <payload-dir> <platform> <source-sha> <tag> <receipt>",
		);
	const actualPlatform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	if (actualPlatform !== platform || !/^[a-f0-9]{40}$/.test(sourceSha))
		throw new Error("Smoke runner platform/source mismatch");
	const directory = resolve(directoryArg),
		root = await mkdtemp(join(tmpdir(), "pi-memory-smoke-"));
	try {
		const build = await readBuildIdentity(directory, sourceSha, releaseTag);
		const archive = join(directory, archiveName(platform)),
			before = await sha256(archive);
		if (before !== build.artifacts[platform].archiveSha256) throw new Error("Archive differs from original build");
		const env = isolatedEnvironment(root);
		await run("tar", ["-xf", archive, "-C", root], root, env);
		const binary = join(root, platform.startsWith("windows-") ? "pi.exe" : "pi/pi"),
			binarySha256 = await sha256(binary);
		if (binarySha256 !== build.artifacts[platform].binarySha256)
			throw new Error("Extracted executable differs from original build");
		const memory = await installMemory(root, env);
		await exerciseMemory(binary, memory, root, env);
		if ((await sha256(archive)) !== before || (await sha256(binary)) !== binarySha256)
			throw new Error("Candidate bytes changed during memory smoke");
		await writeFile(
			resolve(output),
			`${JSON.stringify({ schemaVersion: 1, platform, sourceSha, releaseTag, archiveSha256: before, binarySha256, memory: { ...MEMORY, passed: true } }, null, 2)}\n`,
			{ flag: "wx" },
		);
		console.log(`Real pi-memory ${MEMORY.version} write/read passed: ${platform} ${binarySha256}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url)
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
