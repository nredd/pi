/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { type SpawnSyncReturns, spawnSync } from "child_process";
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
export type CommandRunner = (command: string) => CommandRun | Promise<CommandRun>;

/** A `!command` attempt that failed: the reason the error text carries. */
type CommandFailure = { failure: string };

const COMMAND_TIMEOUT_MS = 10_000;
/** Longest stderr tail an error carries. */
const COMMAND_STDERR_CHARS = 1_000;

function toCommandRun(result: SpawnSyncReturns<string>): CommandRun {
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

/** The configured Windows shell's run, or `undefined` when that shell is unavailable. */
function runWithConfiguredShell(command: string): CommandRun | undefined {
	let result: SpawnSyncReturns<string>;
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: COMMAND_TIMEOUT_MS,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
	} catch {
		return undefined;
	}
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
	return toCommandRun(result);
}

/** Run a `!command` once with the platform shell. stdout and stderr are captured, never echoed. */
function runCommand(command: string): CommandRun {
	const configured = process.platform === "win32" ? runWithConfiguredShell(command) : undefined;
	return (
		configured ??
		toCommandRun(
			spawnSync(command, {
				encoding: "utf-8",
				timeout: COMMAND_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "pipe"],
				shell: true,
				windowsHide: true,
			}),
		)
	);
}

// A credential that leaks into stderr or into the command text is replaced before
// either reaches an error message. Three shapes: an auth scheme with its value, a
// `key=value` / `token: value` pair, and any long opaque run of token characters
// with both letters and digits (API keys, JWT segments, hex digests, UUIDs).
// Dots and slashes end a run, so hostnames, URLs and paths stay readable.
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+[^\s"',;]+/gi;
const SECRET_ASSIGNMENT_RE =
	/\b([\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization)[\w-]*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\s)[^\s"',;]+/gi;
const OPAQUE_TOKEN_RE = /[A-Za-z0-9_+=-]{20,}/g;
const REDACTED = "[REDACTED]";

/** `text` with anything that looks like a credential replaced by `[REDACTED]`. */
export function redactSecrets(text: string): string {
	return text
		.replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`)
		.replace(SECRET_ASSIGNMENT_RE, `$1${REDACTED}`)
		.replace(OPAQUE_TOKEN_RE, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? REDACTED : run));
}

/** The secret a run printed, or why it produced none. Never includes stdout in a failure. */
function commandOutcome(run: CommandRun): { value: string } | CommandFailure {
	const value = run.stdout.trim();
	let failure: string;
	if (run.error && run.status === null) {
		failure = `could not run the command (${run.error.message})`;
	} else if (run.status !== 0) {
		failure = run.signal ? `command was killed by ${run.signal}` : `command exited with code ${run.status}`;
	} else if (value) {
		return { value };
	} else {
		failure = "command exited 0 but printed no secret (empty output)";
	}
	const stderr = run.stderr.trim();
	return stderr
		? { failure: `${failure}; stderr: ${redactSecrets(stderr.slice(-COMMAND_STDERR_CHARS))}` }
		: { failure };
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
	run: runCommand,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

// In-memory only: a resolved secret is never written to disk or logged.
const commandSecretCache = new Map<string, { value: string; expiresAt: number }>();
const commandSecretInFlight = new Map<string, Promise<string>>();

async function resolveCommandSecret(
	commandConfig: string,
	description: string,
	cacheKey: string,
	deps: CommandSecretDeps,
): Promise<string> {
	let failure = "";
	for (let attempt = 0; attempt < COMMAND_SECRET_ATTEMPTS; attempt++) {
		if (attempt > 0) await deps.sleep(COMMAND_SECRET_RETRY_DELAYS_MS[attempt - 1]);
		const outcome = commandOutcome(await deps.run(commandConfig.slice(1)));
		if ("value" in outcome) {
			commandSecretCache.set(cacheKey, { value: outcome.value, expiresAt: deps.now() + COMMAND_SECRET_TTL_MS });
			return outcome.value;
		}
		failure = outcome.failure;
	}
	throw commandError(description, commandConfig, `${failure}; failed ${COMMAND_SECRET_ATTEMPTS} attempts`);
}

/**
 * Request-time variant of {@link resolveConfigValueOrThrow}. A `!command` that
 * fails is retried up to {@link COMMAND_SECRET_ATTEMPTS} times with short
 * backoff, since secret helpers fail transiently under concurrency. Its output
 * is reused for {@link COMMAND_SECRET_TTL_MS} per `description` and command, and
 * concurrent callers share one run. Failures are never cached. Environment and
 * literal values resolve exactly as in the synchronous variant.
 */
export async function resolveConfigValueOrThrowWithRetry(
	config: string,
	description: string,
	env?: Record<string, string>,
	deps: CommandSecretDeps = commandSecretDeps,
): Promise<string> {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "command") return resolveConfigValueOrThrow(config, description, env);
	const cacheKey = `${description}\0${reference.config}`;
	const cached = commandSecretCache.get(cacheKey);
	if (cached && cached.expiresAt > deps.now()) return cached.value;
	commandSecretCache.delete(cacheKey);
	const pending = commandSecretInFlight.get(cacheKey);
	if (pending) return pending;
	const run = resolveCommandSecret(reference.config, description, cacheKey, deps).finally(() => {
		commandSecretInFlight.delete(cacheKey);
	});
	commandSecretInFlight.set(cacheKey, run);
	return run;
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

/** Clear both config value command caches. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	commandSecretCache.clear();
}
