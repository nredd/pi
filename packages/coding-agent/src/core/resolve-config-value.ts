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

/** Runs the shell text of a `!command` (without the `!`). */
export type CommandRunner = (command: string) => Promise<CommandRun>;

/** Why a `!command` attempt produced no secret, and whether running it again could help. */
interface CommandFailure {
	failure: string;
	/** The shell could not find or execute the command (exit 126/127, or it never started). */
	permanent: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;
/** Longest stderr tail an error carries. */
const COMMAND_STDERR_CHARS = 1_000;

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

function runAsync(invocation: ShellInvocation, timeoutMs: number): Promise<CommandRun> {
	return new Promise((resolve) => {
		const child = spawn(invocation.file, invocation.args, {
			stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			shell: invocation.shell,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let error: Error | undefined;
		child.stdout?.setEncoding("utf-8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf-8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdin?.end(invocation.stdin);
		const timer = setTimeout(() => {
			error = new Error(`timed out after ${timeoutMs} ms`);
			child.kill("SIGTERM");
		}, timeoutMs);
		let started = true;
		child.on("error", (spawnError) => {
			started = false;
			error = spawnError;
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			// Node reports a spawn failure as exit -2 (or similar); it never ran, so it has no status.
			resolve({ status: started ? status : null, signal, stdout, stderr, error });
		});
	});
}

/** Run a `!command` once without blocking the event loop. The live runner of the retrying resolver. */
export async function runCommandAsync(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandRun> {
	const configured = configuredWindowsShell(command);
	const run = configured && (await runAsync(configured, timeoutMs));
	return run && !isMissingShell(run.error) ? run : runAsync(defaultShell(command), timeoutMs);
}

// A credential that leaks into stderr, an error message or the command text is replaced
// before it reaches an error message. Shapes covered: URL userinfo, an auth scheme with a
// token-like value, `key=value` / `token: value` pairs, a secret-named flag followed by its
// value, and opaque runs of token characters (API keys, base64, JWTs, hex digests, UUIDs).
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)(\s+)([^\s"',;]{8,})/gi;
const SECRET_NAME = String.raw`[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization)[\w-]*`;
const SECRET_ASSIGNMENT_RE = new RegExp(
	String.raw`\b(${SECRET_NAME}["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\s)[^\s"',;]+`,
	"gi",
);
const SECRET_FLAG_RE = new RegExp(
	String.raw`(^|\s)(--?(?:${SECRET_NAME}|key|p))(\s+)(?!-)("[^"]*"|'[^']*'|[^\s"']+)`,
	"gi",
);
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
			.replace(AUTH_SCHEME_RE, (match, scheme: string, space: string, value: string) =>
				/^[A-Z]?[a-z]+$/.test(value) ? match : `${scheme}${space}${REDACTED}`,
			)
			.replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`)
			.replace(SECRET_FLAG_RE, `$1$2$3${REDACTED}`)
			.replace(TOKEN_RUN_RE, (run) => (isOpaqueToken(run) ? REDACTED : run))
	);
}

/** The secret a run printed, or why it produced none. Failed-run stdout never reaches the reason. */
function commandOutcome(run: CommandRun): { value: string } | CommandFailure {
	const value = run.stdout.trim();
	let failure: string;
	let permanent = false;
	if (run.error && run.status === null) {
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
	// Redact the whole stderr first: cutting it first could drop a `Bearer`/`key=` prefix
	// and leave its value in the tail unrecognized.
	const stderr = redactSecrets(run.stderr.trim()).slice(-COMMAND_STDERR_CHARS);
	return { failure: redactSecrets(stderr ? `${failure}; stderr: ${stderr}` : failure), permanent };
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
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** The live effects. Tests replace members with `vi.spyOn` to avoid real sleeps and clocks. */
export const commandSecretDeps: CommandSecretDeps = {
	run: (command) => runCommandAsync(command),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

// In-memory only: a resolved secret is never written to disk or logged. A run may write its
// result only while it still owns its in-flight slot, so a clear or an invalidation that lands
// mid-run is never undone by that run.
const commandSecretCache = new Map<string, { value: string; expiresAt: number }>();
const commandSecretInFlight = new Map<string, { owner: object; result: Promise<string> }>();

const commandSecretKey = (commandConfig: string, description: string) => `${description}\0${commandConfig}`;

async function resolveCommandSecret(
	commandConfig: string,
	description: string,
	cacheKey: string,
	owner: object,
	deps: CommandSecretDeps,
): Promise<string> {
	let attempt = 0;
	for (;;) {
		const outcome = commandOutcome(await deps.run(commandConfig.slice(1)));
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
		await deps.sleep(COMMAND_SECRET_RETRY_DELAYS_MS[attempt - 1]);
	}
}

/**
 * Request-time variant of {@link resolveConfigValueOrThrow}. A `!command` runs without
 * blocking the event loop; one that fails is retried up to {@link COMMAND_SECRET_ATTEMPTS}
 * times with short backoff, since secret helpers fail transiently under concurrency, unless
 * the failure is permanent (exit 126/127, or the shell is missing). Its output is reused for
 * {@link COMMAND_SECRET_TTL_MS} per `description` and command, and concurrent callers share
 * one run. Failures are never cached. Environment and literal values resolve exactly as in
 * the synchronous variant.
 */
export async function resolveConfigValueOrThrowWithRetry(
	config: string,
	description: string,
	env?: Record<string, string>,
	deps: CommandSecretDeps = commandSecretDeps,
): Promise<string> {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return resolveConfigValueOrThrow(config, description, env);
	const cacheKey = commandSecretKey(reference.config, description);
	const cached = commandSecretCache.get(cacheKey);
	if (cached && cached.expiresAt > deps.now()) return cached.value;
	commandSecretCache.delete(cacheKey);
	const pending = commandSecretInFlight.get(cacheKey);
	if (pending) return pending.result;
	const owner = {};
	const result = resolveCommandSecret(reference.config, description, cacheKey, owner, deps).finally(() => {
		if (commandSecretInFlight.get(cacheKey)?.owner === owner) commandSecretInFlight.delete(cacheKey);
	});
	commandSecretInFlight.set(cacheKey, { owner, result });
	return result;
}

/**
 * Forget the cached result of `config` resolved for `description`, and detach any run in
 * flight so it cannot write one back. Call it when the provider rejects the key (401/403),
 * so the next request runs the command again. A no-op for non-command values.
 */
export function invalidateCommandSecret(config: string, description: string): void {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return;
	const cacheKey = commandSecretKey(reference.config, description);
	commandSecretCache.delete(cacheKey);
	commandSecretInFlight.delete(cacheKey);
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
