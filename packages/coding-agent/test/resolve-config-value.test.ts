import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	commandSecretDeps,
	invalidateCommandSecret,
	redactSecrets,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueOrThrowWithRetry,
	resolveConfigValueUncached,
	runCommandAsync,
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
		const signals: AbortSignal[] = [];
		const clock = { now: 5_000 };
		const deps: CommandSecretDeps = {
			run: async (command, signal) => {
				commands.push(command);
				if (signal) signals.push(signal);
				return runs[Math.min(commands.length - 1, runs.length - 1)];
			},
			sleep: async (ms, signal) => {
				sleeps.push(ms);
				if (signal) signals.push(signal);
			},
			now: () => clock.now,
		};
		return { deps, commands, sleeps, signals, clock };
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
			{ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: new Error("timed out after 10000 ms") },
			"could not run the command (timed out after 10000 ms)",
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

	test("uses the real async runner by default", async () => {
		const sleep = vi.spyOn(commandSecretDeps, "sleep").mockResolvedValue(undefined);

		await expect(resolveConfigValueOrThrowWithRetry("!exit 9", "API key")).rejects.toThrow(
			"command exited with code 9",
		);
		expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...COMMAND_SECRET_RETRY_DELAYS_MS]);
		expect(await resolveConfigValueOrThrowWithRetry("!echo real-runner", "API key")).toBe("real-runner");
	});

	test("the default sleep and clock are a timer and Date.now", async () => {
		vi.useFakeTimers({ now: 42_000 });
		try {
			expect(commandSecretDeps.now()).toBe(42_000);
			let slept = false;
			const sleeping = commandSecretDeps.sleep(200).then(() => {
				slept = true;
			});
			await vi.advanceTimersByTimeAsync(199);
			expect(slept).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await sleeping;
			expect(slept).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test.each([
		["exit 127 (command not found)", exit(127, "sh: secret-helper: not found"), "command exited with code 127"],
		["exit 126 (not executable)", exit(126, "sh: secret-helper: Permission denied"), "command exited with code 126"],
		[
			"a shell that never started",
			{
				status: null,
				signal: null,
				stdout: "",
				stderr: "",
				error: Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" }),
			},
			"could not run the command (spawn /bin/sh ENOENT)",
		],
	] satisfies [string, CommandRun, string][])(
		"does not retry a permanent failure: %s",
		async (_name, run, failure) => {
			const { deps, commands, sleeps } = fakeDeps(run, ok("never-reached"));

			await expect(
				resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
			).rejects.toThrow(`${failure}`);
			await expect(
				rejection(resolveConfigValueOrThrowWithRetry("!other-helper", "API key", undefined, fakeDeps(run).deps)),
			).resolves.toMatchObject({ message: expect.stringContaining("failed 1 attempt)") });
			expect(commands).toHaveLength(1);
			expect(sleeps).toEqual([]);
		},
	);

	test("concurrent waiters on a failing command all reject, and the next call runs it again", async () => {
		let release: (run: CommandRun) => void = () => {};
		const { deps, commands } = fakeDeps(exit(1));
		deps.run = async (command) => {
			commands.push(command);
			if (commands.length === 1) {
				return new Promise<CommandRun>((resolve) => {
					release = resolve;
				});
			}
			return commands.length <= COMMAND_SECRET_ATTEMPTS ? exit(1, "busy") : ok("key-after");
		};

		const waiters = [1, 2, 3].map(() =>
			rejection(resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)),
		);
		release(exit(1, "busy"));
		const errors = await Promise.all(waiters);

		expect(errors.map((error) => error.message)).toEqual(Array(3).fill(errors[0].message));
		expect(errors[0].message).toContain("failed 3 attempts");
		expect(commands).toHaveLength(COMMAND_SECRET_ATTEMPTS);
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe(
			"key-after",
		);
		expect(commands).toHaveLength(COMMAND_SECRET_ATTEMPTS + 1);
	});

	test.each([
		[
			"clearConfigValueCache stops a run in flight from caching its result",
			() => clearConfigValueCache(),
			2,
			"key-2",
		],
		[
			"invalidateCommandSecret keeps a run in flight, which started after the rejected key was handed out",
			() => invalidateCommandSecret("!secret-helper get", "API key", "key-0"),
			1,
			"key-1",
		],
	] as const)("%s", async (_name, clear, runs, next) => {
		let release: (run: CommandRun) => void = () => {};
		const { deps, commands } = fakeDeps(ok("key-2"));
		deps.run = async (command) => {
			commands.push(command);
			return commands.length === 1
				? new Promise<CommandRun>((resolve) => {
						release = resolve;
					})
				: ok("key-2");
		};

		const stale = resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		clear();
		release(ok("key-1"));

		expect(await stale).toBe("key-1");
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe(next);
		expect(commands).toHaveLength(runs);
	});

	test("invalidateCommandSecret drops only the rejected cached value, and ignores non-command values", async () => {
		const { deps, commands } = fakeDeps(ok("key-1"), ok("key-2"));

		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-1",
		);
		invalidateCommandSecret("literal-key", "provider a", "key-1");
		invalidateCommandSecret("!secret-helper get", "provider b", "key-1");
		// A newer key than the rejected one is kept.
		invalidateCommandSecret("!secret-helper get", "provider a", "key-0");
		invalidateCommandSecret("!secret-helper get", "provider a", undefined);
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-1",
		);
		invalidateCommandSecret("!secret-helper get", "provider a", "key-1");
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "provider a", undefined, deps)).toBe(
			"key-2",
		);
		expect(commands).toHaveLength(2);
	});

	test("redacts stderr before cutting it to its tail, so a cut prefix cannot expose the value", async () => {
		// Letters only, so only the `Bearer` prefix marks it as a credential.
		const token = "abcdefghijklmnopqrstuvwxyzABCDEF";
		const filler = "y".repeat(1_000 - token.length - 1);
		const { deps } = fakeDeps(exit(1, `Authorization: Bearer ${token} ${filler}`));

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		);

		expect(error.message).not.toContain(token);
		expect(error.message).toContain(filler.slice(0, 100));
	});

	test("only a fully aborted run stops; each waiter leaves with its own abort reason", async () => {
		let release: (run: CommandRun) => void = () => {};
		const { deps, commands, signals } = fakeDeps(ok("unused"));
		deps.run = async (command, signal) => {
			commands.push(command);
			if (signal) signals.push(signal);
			return new Promise<CommandRun>((resolve) => {
				release = resolve;
			});
		};
		const [a, b] = [new AbortController(), new AbortController()];

		const first = rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps, a.signal),
		);
		const second = rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps, b.signal),
		);
		a.abort(new Error("first request cancelled"));
		expect((await first).message).toBe("first request cancelled");
		expect(signals[0].aborted).toBe(false);
		b.abort(new Error("second request cancelled"));
		expect((await second).message).toBe("second request cancelled");
		expect(signals[0].aborted).toBe(true);
		// The stopped run's late result is discarded, not cached.
		release(ok("key-late"));
		await Promise.resolve();
		expect(commands).toHaveLength(1);

		deps.run = async (command) => {
			commands.push(command);
			return ok("key-fresh");
		};
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe(
			"key-fresh",
		);
		expect(commands).toHaveLength(2);
	});

	test("aborting a run detached by a clear leaves the run that replaced it alone", async () => {
		const releases: Array<(run: CommandRun) => void> = [];
		const { deps, commands } = fakeDeps(ok("unused"));
		deps.run = async (command) => {
			commands.push(command);
			return new Promise<CommandRun>((resolve) => {
				releases.push(resolve);
			});
		};
		const controller = new AbortController();

		const detached = rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps, controller.signal),
		);
		clearConfigValueCache();
		const current = resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		controller.abort(new Error("cancelled"));
		await detached;
		releases[1](ok("key-current"));

		expect(await current).toBe("key-current");
		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe(
			"key-current",
		);
		expect(commands).toHaveLength(2);
	});

	test("a waiter without a signal keeps the shared run alive", async () => {
		let release: (run: CommandRun) => void = () => {};
		const { deps, signals } = fakeDeps(ok("unused"));
		deps.run = async (_command, signal) => {
			if (signal) signals.push(signal);
			return new Promise<CommandRun>((resolve) => {
				release = resolve;
			});
		};
		const controller = new AbortController();

		const leaving = rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps, controller.signal),
		);
		const staying = resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps);
		controller.abort(new Error("cancelled"));
		await leaving;
		release(ok("key-1"));

		expect(await staying).toBe("key-1");
		expect(signals[0].aborted).toBe(false);
	});

	test("passes the run's signal to the command and the retry sleeps, and rejects an aborted request at once", async () => {
		const { deps, commands, signals } = fakeDeps(exit(1), ok("key-1"));

		expect(await resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps)).toBe("key-1");
		expect(signals).toHaveLength(3);
		expect(new Set(signals).size).toBe(1);

		const aborted = AbortSignal.abort(new Error("already cancelled"));
		clearConfigValueCache();
		await expect(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps, aborted),
		).rejects.toThrow("already cancelled");
		expect(commands).toHaveLength(2);
	});

	test("the default sleep stops when its signal aborts", async () => {
		await expect(commandSecretDeps.sleep(60_000, AbortSignal.abort(new Error("gone")))).rejects.toThrow("gone");
		const controller = new AbortController();
		const sleeping = commandSecretDeps.sleep(60_000, controller.signal);
		controller.abort(new Error("gone later"));
		await expect(sleeping).rejects.toThrow("gone later");
		await expect(commandSecretDeps.sleep(1, new AbortController().signal)).resolves.toBeUndefined();
	});

	test("never returns output a run could not finish, such as capped stdout", async () => {
		const { deps } = fakeDeps({
			status: 0,
			signal: null,
			stdout: "partial-key",
			stderr: "",
			error: new Error("stdout exceeded 1048576 bytes"),
		});

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		);

		expect(error.message).toContain("(stdout exceeded 1048576 bytes)");
		expect(error.message).not.toContain("partial-key");
	});

	test("redaction only ever sees a bounded stderr window, however much the command printed", async () => {
		// 1.2 MB of `ab-ab-...`: the shape that made the old `key=` pattern backtrack quadratically.
		const { deps } = fakeDeps(exit(1, `${"ab-".repeat(400_000)}token=fake-secret-value`));
		const inputs: number[] = [];
		const replace = RegExp.prototype[Symbol.replace];
		vi.spyOn(RegExp.prototype, Symbol.replace).mockImplementation(function (
			this: RegExp,
			text: string,
			replacer: (substring: string, ...args: unknown[]) => string,
		) {
			inputs.push(text.length);
			return replace.call(this, text, replacer);
		});

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		);

		expect(error.message).toContain("token=[REDACTED]");
		expect(error.message).not.toContain("fake-secret-value");
		expect(Math.max(...inputs)).toBeLessThan(6_000);
	});

	test("redacts a spawn error message", async () => {
		const { deps } = fakeDeps({
			status: null,
			signal: null,
			stdout: "",
			stderr: "",
			error: new Error("spawn secret-helper --password hunter2 EACCES"),
		});

		const error = await rejection(
			resolveConfigValueOrThrowWithRetry("!secret-helper get", "API key", undefined, deps),
		);

		expect(error.message).toContain("could not run the command (spawn secret-helper --password [REDACTED] EACCES)");
		expect(error.message).not.toContain("hunter2");
	});
});

describe("redactSecrets", () => {
	test.each([
		["Bearer abc.def.ghi", "Bearer [REDACTED]"],
		["Authorization: Bearer abcdefghijkl", "Authorization: Bearer [REDACTED]"],
		["HELPER_TOKEN=abc", "HELPER_TOKEN=[REDACTED]"],
		["helper -P hunter2", "helper -P [REDACTED]"],
		["Token Zm9vYmFyYmF6", "Token [REDACTED]"],
		["blob dGhpcyBpcyBhIHNlY3JldA/9xQ== end", "blob [REDACTED] end"],
		["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl", "jwt [REDACTED]"],
		["helper --password hunter2 --url x", "helper --password [REDACTED] --url x"],
		["helper -p hunter2", "helper -p [REDACTED]"],
		["helper --token abc --verbose", "helper --token [REDACTED] --verbose"],
		["helper --api-key 'two words'", "helper --api-key [REDACTED]"],
		["fetch https://alice:s3cret@vault.example.com/v1", "fetch https://[REDACTED]@vault.example.com/v1"],
		["clone https://ghp_abc@github.com/o/r", "clone https://[REDACTED]@github.com/o/r"],
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
		"Token refresh failed",
		"Basic authentication required",
		"helper --verbose -q",
		"see https://docs.example.com/v1/errors/expired-credentials-handling",
		"retry_count=3 and mode: fast",
		"helper --url https://example.com",
		"ab-".repeat(80_000),
	])("keeps %s readable", (input) => {
		expect(redactSecrets(input)).toBe(input);
	});
});

describe("runCommandAsync (pi-harness#456)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("captures stdout, stderr and the exit code without blocking", async () => {
		await expect(runCommandAsync("printf out; printf err >&2; exit 3")).resolves.toMatchObject({
			status: 3,
			signal: null,
			stdout: "out",
			stderr: "err",
		});
	});

	test("kills a command that outlives its timeout", async () => {
		const result = await runCommandAsync("exec sleep 30", { timeoutMs: 50 });

		expect(result).toMatchObject({ status: null, signal: "SIGTERM" });
		expect(result.error?.message).toBe("timed out after 50 ms");
	});

	test("escalates to SIGKILL when the command ignores SIGTERM", async () => {
		const result = await runCommandAsync("trap '' TERM; while :; do sleep 0.05; done", {
			timeoutMs: 50,
			killGraceMs: 50,
		});

		expect(result).toMatchObject({ status: null, signal: "SIGKILL" });
		expect(result.error?.message).toBe("timed out after 50 ms");
	});

	test("stops a command when its signal aborts", async () => {
		const controller = new AbortController();
		const run = runCommandAsync("exec sleep 30", { signal: controller.signal });
		controller.abort();

		await expect(run).resolves.toMatchObject({ signal: "SIGTERM", error: { message: "aborted" } });
		await expect(runCommandAsync("exec sleep 30", { signal: AbortSignal.abort() })).resolves.toMatchObject({
			error: { message: "aborted" },
		});
	});

	test("finishes when the shell exits even if a grandchild still holds its pipes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-grandchild-"));
		const pidFile = join(dir, "pid");
		try {
			const result = await runCommandAsync(`sleep 30 & echo $! > '${pidFile}'; echo key-from-shell`, {
				exitGraceMs: 20,
			});

			expect(result).toMatchObject({ status: 0, signal: null, stdout: "key-from-shell\n" });
		} finally {
			// The backgrounded `sleep` was spawned by this test: stop exactly that pid.
			const pid = Number(readFileSync(pidFile, "utf-8").trim());
			if (pid > 1) process.kill(pid, "SIGTERM");
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("caps each output stream at 1 MB", async () => {
		const result = await runCommandAsync("head -c 3000000 /dev/zero | tr '\\0' a; echo done >&2");

		expect(result.stdout).toHaveLength(1024 * 1024);
		expect(result.stdout).toMatch(/^a+$/);
		expect(result.error?.message).toBe("stdout exceeded 1048576 bytes");
	});

	test("feeds stdin to a configured Windows shell that reads its command from stdin", async () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/sh",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			await expect(runCommandAsync("echo from-stdin")).resolves.toMatchObject({ status: 0, stdout: "from-stdin\n" });
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	test("survives a configured stdin shell that exits without reading its stdin (EPIPE)", async () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/sh",
			args: ["-c", "exit 3"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			await expect(runCommandAsync("x".repeat(8 * 1024 * 1024))).resolves.toMatchObject({ status: 3 });
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	test("falls back to the default shell when the configured Windows shell is missing or unknown", async () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const getShellConfig = vi.spyOn(shellModule, "getShellConfig");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			getShellConfig.mockReturnValue({ shell: "/nonexistent/bash-456", args: ["-c"], commandTransport: "argv" });
			// Off Windows the fallback's `cmd.exe` cannot start either, which shows it was reached.
			const missing = await runCommandAsync("echo hi");
			expect(missing).toMatchObject({ status: null, error: { code: "ENOENT" } });
			expect(missing.error?.message).toContain("cmd.exe");
			getShellConfig.mockImplementation(() => {
				throw new Error("no shell");
			});
			expect((await runCommandAsync("echo hi")).error?.message).toContain("cmd.exe");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});
