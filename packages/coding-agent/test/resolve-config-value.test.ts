import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	COMMAND_SECRET_ATTEMPTS,
	COMMAND_SECRET_RETRY_DELAYS_MS,
	COMMAND_SECRET_TTL_MS,
	type CommandRun,
	type CommandSecretDeps,
	clearConfigValueCache,
	redactSecrets,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueOrThrowWithRetry,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("resolveConfigValue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	test("resolves literals, environment templates, and escapes", () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(resolveConfigValue("literal-key")).toBe("literal-key");
			expect(resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe("credential");
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", () => {
		expect(resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		(command) => {
			expect(resolveConfigValue(command)).toBeUndefined();
		},
	);

	test("caches successful and failed commands until explicitly cleared", () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(resolveConfigValue(success)).toBe("value");
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		clearConfigValueCache();
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("does not cache environment values", () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test("uses stdin when the configured Windows shell requires it", () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});

describe("resolveConfigValueOrThrow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("names the exit code and stderr of a failed command (pi-harness#456)", () => {
		expect(() =>
			resolveConfigValueOrThrow("!sh -c 'echo stdout-only; echo helper offline >&2; exit 3'", "API key"),
		).toThrow(
			"Failed to resolve API key from shell command: sh -c 'echo stdout-only; echo helper offline >&2; exit 3' (command exited with code 3; stderr: helper offline)",
		);
	});

	test("says a command printed nothing instead of implying the secret is missing (pi-harness#456)", () => {
		expect(() => resolveConfigValueOrThrow("!printf ''", "API key")).toThrow(
			"Failed to resolve API key from shell command: printf '' (command exited 0 but printed no secret (empty output))",
		);
	});

	test("still names a missing environment variable", () => {
		delete process.env.TEST_CONFIG_UNSET_456;
		expect(() => resolveConfigValueOrThrow("$TEST_CONFIG_UNSET_456", "API key")).toThrow(
			"Failed to resolve API key from environment variable: TEST_CONFIG_UNSET_456",
		);
		expect(() => resolveConfigValueOrThrow("$TEST_CONFIG_UNSET_456-$TEST_CONFIG_UNSET_457", "API key")).toThrow(
			"Failed to resolve API key from environment variables: TEST_CONFIG_UNSET_456, TEST_CONFIG_UNSET_457",
		);
	});

	test("resolves literals and commands", () => {
		expect(resolveConfigValueOrThrow("literal", "API key")).toBe("literal");
		expect(resolveConfigValueOrThrow("!echo from-command", "API key")).toBe("from-command");
	});

	test("falls back to the default shell when the configured Windows shell is unavailable", () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const getShellConfig = vi.spyOn(shellModule, "getShellConfig");
		// Off Windows the fallback's `cmd.exe` cannot start either, which shows it was reached
		// and that a command that never started reads as such.
		const fellBack = "(could not run the command (spawnSync cmd.exe ENOENT))";
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			getShellConfig.mockReturnValue({ shell: "/nonexistent/bash-456", args: ["-c"], commandTransport: "argv" });
			expect(() => resolveConfigValueOrThrow("!echo via-default-shell", "API key")).toThrow(fellBack);
			getShellConfig.mockImplementation(() => {
				throw new Error("no shell");
			});
			expect(() => resolveConfigValueOrThrow("!echo via-default-shell", "API key")).toThrow(fellBack);
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});

describe("resolveConfigValueOrThrowWithRetry (pi-harness#456)", () => {
	const ok = (stdout: string): CommandRun => ({ status: 0, signal: null, stdout, stderr: "" });
	const exit = (status: number, stderr = ""): CommandRun => ({ status, signal: null, stdout: "", stderr });

	/** A fake runner returning `runs` in order (the last one repeats), a recording sleep, and a settable clock. */
	function fakeDeps(...runs: CommandRun[]) {
		const commands: string[] = [];
		const sleeps: number[] = [];
		const clock = { now: 5_000 };
		const deps: CommandSecretDeps = {
			run: (command) => {
				commands.push(command);
				return runs[Math.min(commands.length - 1, runs.length - 1)];
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			now: () => clock.now,
		};
		return { deps, commands, sleeps, clock };
	}

	/** The error `promise` rejects with. */
	async function rejection(promise: Promise<unknown>): Promise<Error> {
		try {
			await promise;
		} catch (error) {
			return error as Error;
		}
		throw new Error("expected a rejection");
	}

	beforeEach(() => {
		clearConfigValueCache();
	});

	afterEach(() => {
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	test("retries a failing command with backoff until it succeeds", async () => {
		const { deps, commands, sleeps } = fakeDeps(exit(1, "busy"), exit(1, "busy"), ok("  key-1  \n"));

		await expect(resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).resolves.toBe(
			"key-1",
		);
		expect(commands).toEqual(["secret-helper get", "secret-helper get", "secret-helper get"]);
		expect(sleeps).toEqual([...COMMAND_SECRET_RETRY_DELAYS_MS]);
	});

	test("gives up after every attempt and reports the last failure", async () => {
		const { deps, commands } = fakeDeps(exit(2, "first"), exit(5, "upstream 503"));

		await expect(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		).rejects.toThrow(
			`Failed to resolve API key from shell command: secret-helper get (command exited with code 5; stderr: upstream 503; failed ${COMMAND_SECRET_ATTEMPTS} attempts)`,
		);
		expect(commands).toHaveLength(COMMAND_SECRET_ATTEMPTS);
	});

	test.each([
		[{ status: 0, signal: null, stdout: " \n", stderr: "" }, "command exited 0 but printed no secret (empty output)"],
		[{ status: null, signal: "SIGTERM", stdout: "", stderr: "" }, "command was killed by SIGTERM"],
		[
			{ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: new Error("spawnSync /bin/sh ETIMEDOUT") },
			"could not run the command (spawnSync /bin/sh ETIMEDOUT)",
		],
		[
			{ status: 127, signal: null, stdout: "", stderr: "sh: secret-helper: not found" },
			"command exited with code 127",
		],
	] satisfies [CommandRun, string][])("distinguishes %#: %s", async (run, failure) => {
		const { deps } = fakeDeps(run);

		await expect(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		).rejects.toThrow(failure);
	});

	test("redacts credentials in stderr and the command, and never echoes stdout of a failed run", async () => {
		const { deps } = fakeDeps({
			status: 1,
			signal: null,
			stdout: "stdout-secret-0123456789abcdef",
			stderr: "401 for Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl12",
		});

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry(
				"!secret-helper get --token=hunter2 sk-ant-api03-ABCDEFGHIJ0123456789",
				"API key",
				undefined,
				deps,
			),
		);

		expect(error.message).toBe(
			"Failed to resolve API key from shell command: secret-helper get --token=[REDACTED] [REDACTED] " +
				"(command exited with code 1; stderr: 401 for Authorization: Bearer [REDACTED]; failed 3 attempts)",
		);
	});

	test("keeps only the tail of a long stderr", async () => {
		const { deps } = fakeDeps(exit(1, `${"x".repeat(5_000)} tail-marker`));

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		);

		expect(error.message).toContain("tail-marker");
		expect(error.message.length).toBeLessThan(1_200);
	});

	test("reuses a resolved value until the TTL ends, per description", async () => {
		const { deps, commands, clock } = fakeDeps(ok("key-1"));

		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-1",
		);
		clock.now += COMMAND_SECRET_TTL_MS - 1;
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-1",
		);
		expect(commands).toHaveLength(1);

		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider b", undefined, deps)).toBe(
			"key-1",
		);
		expect(commands).toHaveLength(2);

		clock.now += 1;
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-1",
		);
		expect(commands).toHaveLength(3);
	});

	test("never caches a failure", async () => {
		const { deps, commands } = fakeDeps(exit(1), exit(1), exit(1), ok("key-1"));

		await expect(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		).rejects.toThrow();
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe("key-1");
		expect(commands).toHaveLength(COMMAND_SECRET_ATTEMPTS + 1);
	});

	test("shares one in-flight run between concurrent callers", async () => {
		let release: (run: CommandRun) => void = () => {};
		const pending = new Promise<CommandRun>((resolve) => {
			release = resolve;
		});
		const { deps, commands } = fakeDeps(ok("unused"));
		deps.run = (command) => {
			commands.push(command);
			return pending;
		};

		const first = resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		const second = resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		release(ok("key-1"));

		expect(await Promise.all([first, second])).toEqual(["key-1", "key-1"]);
		expect(commands).toHaveLength(1);
	});

	test("clearConfigValueCache drops cached secrets", async () => {
		const { deps, commands } = fakeDeps(ok("key-1"));

		await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		clearConfigValueCache();
		await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		expect(commands).toHaveLength(2);
	});

	test("resolves environment and literal values without running anything", async () => {
		const { deps, commands } = fakeDeps(ok("unused"));

		expect(
			await resolveConfigValueOrThrowWithRetry("$TEST_CONFIG_RETRY", "API key", { TEST_CONFIG_RETRY: "env" }, deps),
		).toBe("env");
		expect(await resolveConfigValueOrThrowWithRetry("literal", "API key", undefined, deps)).toBe("literal");
		expect(commands).toEqual([]);
	});

	test("uses the real runner, sleep and clock by default", async () => {
		const sleep = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
			callback();
			return 0;
		}) as unknown as typeof setTimeout);

		await expect(resolveConfigValueOrThrowWithRetry("!exit 9", "API key")).rejects.toThrow(
			"command exited with code 9",
		);
		expect(sleep.mock.calls.map(([, ms]) => ms)).toEqual([...COMMAND_SECRET_RETRY_DELAYS_MS]);
		expect(await resolveConfigValueOrThrowWithRetry("!echo real-runner", "API key")).toBe("real-runner");
	});
});

describe("redactSecrets", () => {
	test.each([
		["Bearer abc.def", "Bearer [REDACTED]"],
		["basic dXNlcjpwYXNz", "basic [REDACTED]"],
		["api_key=short1", "api_key=[REDACTED]"],
		['{"access_token": "tok"}', '{"access_token": "[REDACTED]"}'],
		["password: hunter2", "password: [REDACTED]"],
		["using sk-ant-api03-ABCDEFGHIJ0123456789", "using [REDACTED]"],
		["id 0123456789abcdef0123456789abcdef", "id [REDACTED]"],
	])("redacts %s", (input, expected) => {
		expect(redactSecrets(input)).toBe(expected);
	});

	test.each([
		"qgenie secrets get qgenie --url https://qgenie-api.example.com/v1",
		"/opt/homebrew/Cellar/secret-helper/1.2.3/bin/secret-helper",
		"error: connection-refused-while-contacting-server",
		"exit status 1 at 2026-11-04T12:00:00Z",
	])("keeps %s readable", (input) => {
		expect(redactSecrets(input)).toBe(input);
	});
});
