/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { spawn, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/** What one run of a `!command` config value produced. */
export interface CommandRun {
	/** Exit code, or `null` when the command was killed or never started. */
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** Set when the command could not be started or timed out. */
	error?: Error;
}

/** Runs the shell text of a `!command` (without the `!`); `signal` stops it. */
export type CommandRunner = (command: string, signal?: AbortSignal) => Promise<CommandRun>;

/** Why a `!command` attempt produced no secret, and whether running it again could help. */
interface CommandFailure {
	failure: string;
	/** The shell could not find or execute the command (exit 126/127, or it never started). */
	permanent: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;
/**
 * How long a command's pipes may stay open after its shell exits. A backgrounded grandchild
 * can hold them indefinitely; the shell's exit is the end of the run. Pipes normally close
 * within 0.2 ms of the exit (measured over 200 runs), so this only bounds the grandchild case.
 */
const COMMAND_EXIT_GRACE_MS = 100;
/** How long a command gets to exit after SIGTERM before SIGKILL. */
const COMMAND_KILL_GRACE_MS = 2_000;
/** Most bytes kept per output stream: `spawnSync`'s default `maxBuffer`. */
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Longest stderr tail an error carries. */
const COMMAND_STDERR_CHARS = 1_000;
/**
 * How much of the stderr tail is redacted before it is cut to {@link COMMAND_STDERR_CHARS}. The
 * slack keeps a `Bearer`/`key=` prefix just before the kept tail visible to the redaction, and
 * the bound keeps redaction time independent of how much the command printed.
 */
const COMMAND_STDERR_REDACT_CHARS = 4 * COMMAND_STDERR_CHARS;

/** How the platform shell runs `command`: the configured Windows shell, else Node's default shell. */
type ShellInvocation = { file: string; args: string[]; stdin?: string; shell: boolean };

function configuredWindowsShell(command: string): ShellInvocation | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const { shell, args, commandTransport } = getShellConfig();
		return commandTransport === "stdin"
			? { file: shell, args, stdin: command, shell: false }
			: { file: shell, args: [...args, command], shell: false };
	} catch {
		return undefined;
	}
}

const defaultShell = (command: string): ShellInvocation => ({ file: command, args: [], shell: true });

const isMissingShell = (error: Error | undefined) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

function runSync(invocation: ShellInvocation): CommandRun {
	const result = spawnSync(invocation.file, invocation.args, {
		encoding: "utf-8",
		input: invocation.stdin,
		timeout: COMMAND_TIMEOUT_MS,
		stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		shell: invocation.shell,
		windowsHide: true,
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

/** Run a `!command` once, blocking. For the synchronous resolvers only. */
function runCommand(command: string): CommandRun {
	const configured = configuredWindowsShell(command);
	const run = configured && runSync(configured);
	return run && !isMissingShell(run.error) ? run : runSync(defaultShell(command));
}

/** Limits of one {@link runCommandAsync} run. Tests shorten them. */
export interface RunCommandOptions {
	timeoutMs?: number;
	exitGraceMs?: number;
	killGraceMs?: number;
	maxOutputBytes?: number;
	/** Stops the command, as a timeout does. */
	signal?: AbortSignal;
}

/** An error carrying a Node errno-style `code`, as `spawnSync` reports a timeout (`ETIMEDOUT`) or capped output (`ENOBUFS`). */
const codedError = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * Run `invocation` once. On timeout, abort, or output over the cap, the child gets SIGTERM and,
 * {@link RunCommandOptions.killGraceMs} later, SIGKILL. Both go to the child's own pid (the
 * shell), never to a process group: a grandchild started by a compound command (a pipeline, a
 * backgrounded job) can outlive the run. The run still ends at the shell's exit, so such a
 * grandchild cannot hold the request.
 */
function runAsync(invocation: ShellInvocation, options: Required<RunCommandOptions>): Promise<CommandRun> {
	const { timeoutMs, exitGraceMs, killGraceMs, maxOutputBytes, signal } = options;
	return new Promise((resolve) => {
		const child = spawn(invocation.file, invocation.args, {
			stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			shell: invocation.shell,
			windowsHide: true,
		});
		const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
		const bytes = { stdout: 0, stderr: 0 };
		const timers: NodeJS.Timeout[] = [];
		let error: Error | undefined;
		let exit: { status: number | null; signal: NodeJS.Signals | null } | undefined;
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			for (const timer of timers) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			// A grandchild may still hold the pipes: stop reading them.
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.stdin?.destroy();
			resolve({
				// Node reports a spawn failure as exit -2 (or similar); it never ran, so it has no status.
				status: child.pid === undefined ? null : (exit?.status ?? null),
				signal: exit?.signal ?? null,
				stdout: Buffer.concat(output.stdout).toString("utf-8"),
				stderr: Buffer.concat(output.stderr).toString("utf-8"),
				error,
			});
		};
		/**
		 * Stop the command: SIGTERM, then SIGKILL if it has not exited. Only the child itself, never
		 * its group. After the child exited, Node drops its handle and `kill` sends nothing.
		 */
		const stop = (reason: Error) => {
			error ??= reason;
			child.kill("SIGTERM");
			timers.push(setTimeout(() => exit || child.kill("SIGKILL"), killGraceMs));
		};
		const onAbort = () => stop(new Error("aborted"));
		const capture = (name: "stdout" | "stderr") => (chunk: Buffer) => {
			// Once stopping, later chunks are dropped: no second SIGTERM, no extra SIGKILL timer.
			if (error) return;
			const room = maxOutputBytes - bytes[name];
			const kept = chunk.subarray(0, room);
			output[name].push(kept);
			bytes[name] += kept.length;
			if (kept.length < chunk.length) stop(codedError(`${name} exceeded ${maxOutputBytes} bytes`, "ENOBUFS"));
		};

		child.stdout?.on("data", capture("stdout"));
		child.stderr?.on("data", capture("stderr"));
		// A command that exits without reading its stdin closes the pipe (EPIPE); its exit status tells the story.
		child.stdin?.on("error", () => {});
		child.stdin?.end(invocation.stdin);
		child.on("error", (spawnError) => {
			error ??= spawnError;
		});
		child.on("exit", (status, exitSignal) => {
			exit = { status, signal: exitSignal };
			timers.push(setTimeout(finish, exitGraceMs));
		});
		child.on("close", (status, closeSignal) => {
			exit ??= { status, signal: closeSignal };
			finish();
		});
		timers.push(setTimeout(() => stop(codedError(`timed out after ${timeoutMs} ms`, "ETIMEDOUT")), timeoutMs));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Run a `!command` once without blocking the event loop. The live runner of the retrying resolver. */
export async function runCommandAsync(command: string, options: RunCommandOptions = {}): Promise<CommandRun> {
	const limits: Required<RunCommandOptions> = {
		timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
		exitGraceMs: options.exitGraceMs ?? COMMAND_EXIT_GRACE_MS,
		killGraceMs: options.killGraceMs ?? COMMAND_KILL_GRACE_MS,
		maxOutputBytes: options.maxOutputBytes ?? COMMAND_MAX_OUTPUT_BYTES,
		signal: options.signal ?? new AbortController().signal,
	};
	const configured = configuredWindowsShell(command);
	const run = configured && (await runAsync(configured, limits));
	return run && !isMissingShell(run.error) ? run : runAsync(defaultShell(command), limits);
}

// A credential that leaks into stderr, an error message or the command text is replaced
// before it reaches an error message. Shapes covered: URL userinfo, an auth scheme with a
// token-like value, `key=value` / `token: value` pairs, a secret-named flag followed by its
// value, and opaque runs of token characters (API keys, base64, JWTs, hex digests, UUIDs).
//
// Every pattern starts only where a run begins (a lookbehind, not `\b`) and has a single
// unbounded run before a delimiter, so matching stays linear in the input. Whether a name is
// secret-like is decided afterwards on the matched name.
const URL_USERINFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)(\s+)([^\s"',;]{8,})/gi;
const SECRET_NAME_RE = /api[_-]?key|token|secret|password|passwd|credential|authorization/i;
const SECRET_ASSIGNMENT_RE = /(?<![\w-])([\w-]+)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\s)[^\s"',;]+/gi;
const SECRET_FLAG_RE = /(^|\s)(--?([\w-]+))(\s+)(?!-)(?:"[^"]*"|'[^']*'|[^\s"']+)/g;
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_.-]{20,}/g;
const REDACTED = "[REDACTED]";

const lettersAndDigits = (text: string) => /[A-Za-z]/.test(text) && /\d/.test(text);

/**
 * Whether a run of token characters is a credential. Without `/` or `.` any 20+ character
 * run of letters and digits is. With them, hostnames, URLs and paths stay readable unless the
 * run carries base64 markers (`+`, trailing `=`) or a 12+ character letter-and-digit segment
 * (a JWT part, a base64 chunk).
 */
function isOpaqueToken(run: string): boolean {
	if (!/[/.]/.test(run)) return lettersAndDigits(run);
	if (/\+|=$/.test(run) && lettersAndDigits(run)) return true;
	return run.split(/[/.]/).some((segment) => segment.length >= 12 && lettersAndDigits(segment));
}

/** `text` with anything that looks like a credential replaced by `[REDACTED]`. */
export function redactSecrets(text: string): string {
	return (
		text
			.replace(URL_USERINFO_RE, `$1${REDACTED}@`)
			// An all-lowercase or Capitalized word after `Token`/`Basic` is prose ("Token refresh failed").
			// `Bearer` is always followed by a credential.
			.replace(AUTH_SCHEME_RE, (match, scheme: string, space: string, value: string) =>
				!/^bearer$/i.test(scheme) && /^[A-Z]?[a-z]+$/.test(value) ? match : `${scheme}${space}${REDACTED}`,
			)
			.replace(SECRET_ASSIGNMENT_RE, (match, name: string, separator: string) =>
				SECRET_NAME_RE.test(name) ? `${name}${separator}${REDACTED}` : match,
			)
			.replace(SECRET_FLAG_RE, (match, space: string, flag: string, name: string, gap: string) =>
				SECRET_NAME_RE.test(name) || /^(?:key|p)$/i.test(name) ? `${space}${flag}${gap}${REDACTED}` : match,
			)
			.replace(TOKEN_RUN_RE, (run) => (isOpaqueToken(run) ? REDACTED : run))
	);
}

/** The secret a run printed, or why it produced none. Failed-run stdout never reaches the reason. */
function commandOutcome(run: CommandRun): { value: string } | CommandFailure {
	const value = run.stdout.trim();
	let failure: string;
	let permanent = false;
	const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ETIMEDOUT" || code === "ENOBUFS") {
		// Running it again would hit the same limit.
		failure =
			code === "ETIMEDOUT"
				? "command timed out"
				: `command output exceeded ${COMMAND_MAX_OUTPUT_BYTES / (1024 * 1024)} MB`;
		permanent = true;
	} else if (run.error) {
		failure = `could not run the command (${run.error.message})`;
		permanent = isMissingShell(run.error);
	} else if (run.status !== 0) {
		failure = run.signal ? `command was killed by ${run.signal}` : `command exited with code ${run.status}`;
		permanent = run.status === 126 || run.status === 127;
	} else if (value) {
		return { value };
	} else {
		failure = "command exited 0 but printed no secret (empty output)";
	}
	const stderr = stderrTail(run.stderr);
	return { failure: redactSecrets(stderr ? `${failure}; stderr: ${stderr}` : failure), permanent };
}

/**
 * The redacted tail of `stderr`. A window wider than the tail is redacted before the cut, since
 * cutting first could drop a `Bearer`/`key=` prefix and leave its value unrecognized. When the
 * window itself is cut from longer output and starts with a short partial word (up to 64
 * chars, the size of a flag or key name), that word and the one after it are dropped: the cut
 * may have split a value from the flag or key that marks it. A longer partial word is a
 * fragment of a long value, already redacted if it looks like a token. The kept tail is
 * redacted once more, since cutting it can leave a fragment the window pass saw whole.
 */
function stderrTail(stderr: string): string {
	const text = stderr.trim();
	let window = redactSecrets(text.slice(-COMMAND_STDERR_REDACT_CHARS));
	if (text.length > COMMAND_STDERR_REDACT_CHARS) window = window.replace(/^\S{0,64}(?=\s|$)(?:\s+\S*)?\s*/, "");
	return redactSecrets(window.slice(-COMMAND_STDERR_CHARS));
}

function commandError(description: string, commandConfig: string, failure: string): Error {
	return new Error(
		`Failed to resolve ${description} from shell command: ${redactSecrets(commandConfig.slice(1))} (${failure})`,
	);
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const outcome = commandOutcome(runCommand(commandConfig.slice(1)));
	return "value" in outcome ? outcome.value : undefined;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/**
 * Resolve a config value or throw an error naming what failed: a missing
 * environment variable, or a `!command` that exited non-zero, was killed,
 * could not start, or printed nothing (with its redacted stderr). Runs a
 * command once, uncached.
 */
export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		const outcome = commandOutcome(runCommand(reference.config.slice(1)));
		if ("value" in outcome) return outcome.value;
		throw commandError(description, reference.config, outcome.failure);
	}
	const resolvedValue = resolveTemplate(reference.parts, env);
	if (resolvedValue !== undefined) return resolvedValue;
	// A template resolves to undefined only when one of its variables is unset.
	const missing = getMissingConfigValueEnvVarNames(config, env);
	const source = missing.length === 1 ? "environment variable" : "environment variables";
	throw new Error(`Failed to resolve ${description} from ${source}: ${missing.join(", ")}`);
}

/** Attempts per request-time `!command` resolution before the request fails. */
export const COMMAND_SECRET_ATTEMPTS = 3;
/** Wait before each retry of a failed request-time `!command`, in order. */
export const COMMAND_SECRET_RETRY_DELAYS_MS: readonly number[] = [200, 800];
/** How long a request-time `!command` result is reused, per description (provider) and command. */
export const COMMAND_SECRET_TTL_MS = 30_000;

/** Effects of request-time `!command` resolution, injectable by tests. */
export interface CommandSecretDeps {
	run: CommandRunner;
	/** Waits `ms`, or rejects with the abort reason once `signal` aborts. */
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	now: () => number;
}

/** The live effects. Tests replace members with `vi.spyOn` to avoid real sleeps and clocks. */
export const commandSecretDeps: CommandSecretDeps = {
	run: (command, signal) => runCommandAsync(command, { signal }),
	sleep: (ms, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal?.reason);
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
	now: () => Date.now(),
};

// In-memory only: a resolved secret is never written to disk or logged. A run may write its
// result only while it still owns its in-flight slot, so a clear or an invalidation that lands
// mid-run is never undone by that run.
const commandSecretCache = new Map<string, { value: string; expiresAt: number }>();
/**
 * A run shared by concurrent requests. Once every request waiting on it has been aborted it is
 * stopped and detached, so the next request starts a fresh run; a waiter without a signal
 * keeps it alive.
 */
interface InFlightCommandSecret {
	cacheKey: string;
	owner: object;
	result: Promise<string>;
	controller: AbortController;
	waiters: number;
}
const commandSecretInFlight = new Map<string, InFlightCommandSecret>();

const commandSecretKey = (commandConfig: string, description: string) => `${description}\0${commandConfig}`;

async function resolveCommandSecret(
	commandConfig: string,
	description: string,
	cacheKey: string,
	owner: object,
	deps: CommandSecretDeps,
	signal: AbortSignal,
): Promise<string> {
	let attempt = 0;
	for (;;) {
		const run = await deps.run(commandConfig.slice(1), signal);
		signal.throwIfAborted();
		const outcome = commandOutcome(run);
		if ("value" in outcome) {
			if (commandSecretInFlight.get(cacheKey)?.owner === owner) {
				commandSecretCache.set(cacheKey, { value: outcome.value, expiresAt: deps.now() + COMMAND_SECRET_TTL_MS });
			}
			return outcome.value;
		}
		attempt++;
		if (outcome.permanent || attempt >= COMMAND_SECRET_ATTEMPTS) {
			const attempts = attempt === 1 ? "1 attempt" : `${attempt} attempts`;
			throw commandError(description, commandConfig, `${outcome.failure}; failed ${attempts}`);
		}
		await deps.sleep(COMMAND_SECRET_RETRY_DELAYS_MS[attempt - 1], signal);
	}
}

/**
 * Request-time variant of {@link resolveConfigValueOrThrow}. A `!command` runs without
 * blocking the event loop; one that fails is retried up to {@link COMMAND_SECRET_ATTEMPTS}
 * times with short backoff, since secret helpers fail transiently under concurrency, unless
 * the failure is permanent (exit 126/127, or the shell is missing). Its output is reused for
 * {@link COMMAND_SECRET_TTL_MS} per `description` and command, and concurrent callers share
 * one run. Failures are never cached. Environment and literal values resolve exactly as in
 * the synchronous variant. An aborted `signal` rejects this call with its reason, and stops the
 * shared run (its command and retry sleeps) once no other caller is waiting on it.
 */
export async function resolveConfigValueOrThrowWithRetry(
	config: string,
	description: string,
	env?: Record<string, string>,
	deps: CommandSecretDeps = commandSecretDeps,
	signal?: AbortSignal,
): Promise<string> {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return resolveConfigValueOrThrow(config, description, env);
	signal?.throwIfAborted();
	const cacheKey = commandSecretKey(reference.config, description);
	const cached = commandSecretCache.get(cacheKey);
	if (cached && cached.expiresAt > deps.now()) return cached.value;
	commandSecretCache.delete(cacheKey);
	let entry = commandSecretInFlight.get(cacheKey);
	if (!entry) {
		const owner = {};
		const controller = new AbortController();
		const result = resolveCommandSecret(
			reference.config,
			description,
			cacheKey,
			owner,
			deps,
			controller.signal,
		).finally(() => {
			if (commandSecretInFlight.get(cacheKey)?.owner === owner) commandSecretInFlight.delete(cacheKey);
		});
		entry = { cacheKey, owner, result, controller, waiters: 0 };
		commandSecretInFlight.set(cacheKey, entry);
	}
	return awaitCommandSecret(entry, signal);
}

function awaitCommandSecret(entry: InFlightCommandSecret, signal: AbortSignal | undefined): Promise<string> {
	entry.waiters++;
	if (!signal) return entry.result;
	return new Promise((resolve, reject) => {
		const leave = () => {
			reject(signal.reason);
			if (--entry.waiters > 0) return;
			entry.controller.abort(signal.reason);
			if (commandSecretInFlight.get(entry.cacheKey) === entry) commandSecretInFlight.delete(entry.cacheKey);
		};
		signal.addEventListener("abort", leave, { once: true });
		entry.result.then(resolve, reject).finally(() => signal.removeEventListener("abort", leave));
	});
}

/**
 * Forget the cached result of `config` resolved for `description` if it is still
 * `rejectedValue`. Call it when the provider rejects that key (401/403), so the next request
 * runs the command again. A cached value that differs came from a later run, and a run in
 * flight started after the rejected key was handed out; both are kept, so N requests rejected
 * together cause one re-run. A no-op for non-command values.
 */
export function invalidateCommandSecret(config: string, description: string, rejectedValue: string | undefined): void {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return;
	const cacheKey = commandSecretKey(reference.config, description);
	if (commandSecretCache.get(cacheKey)?.value === rejectedValue) commandSecretCache.delete(cacheKey);
}

/** Forget every cached request-time `!command` result and detach every run in flight. */
export function clearCommandSecretCache(): void {
	commandSecretCache.clear();
	commandSecretInFlight.clear();
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear both config value command caches, including request-time runs still in flight. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	clearCommandSecretCache();
}
