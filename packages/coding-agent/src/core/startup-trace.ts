/** Opt-in, bounded startup diagnostics. Never serialize application data. */
const phases = [
	"core.bootstrap",
	"model.catalog.initial",
	"model.registration",
	"model.refresh.offline",
	"resources.reload",
	"resources.discovery",
	"resources.post_extensions",
	"extension.import",
	"extension.factory",
	"session.handlers",
	"session.bind.ready",
	"interactive.init",
	"tui.first_commit",
	"command.extension.dispatch",
	"trace.complete",
] as const;
export type StartupPhase = (typeof phases)[number];
const statuses = ["ok", "error", "cancelled", "skipped", "cached", "reused"] as const;
type Status = (typeof statuses)[number];
interface Span {
	phase: StartupPhase;
	parent: number | null;
	alias?: string;
}
interface Trace {
	begin(phase: StartupPhase, extension?: string): number;
	end(id: number, status: Status): void;
	mark(phase: StartupPhase, status: Status, extension?: string): void;
	run<T>(id: number, action: () => Promise<T>): Promise<T>;
	finish(): void;
}
const key = Symbol.for("pi.startup-trace-v1");
const host = globalThis as typeof globalThis & { [key]?: Trace | null };

/** Initialize once per process, shared by the launcher and bundled SDK. Invalid opt-in fails closed for measurement only. */
function getTrace(): Trace | undefined {
	if (host[key] !== undefined) return host[key] ?? undefined;
	if (process.env.PI_STARTUP_TRACE_FD === undefined) return undefined;
	host[key] = null;
	try {
		const rawFd = process.env.PI_STARTUP_TRACE_FD;
		const runId = process.env.PI_STARTUP_TRACE_RUN_ID ?? "";
		const manifest = process.env.PI_STARTUP_TRACE_ALIASES ?? "{}";
		if (!/^[1-9][0-9]{0,5}$/.test(rawFd) || !/^[a-f0-9]{32}$/.test(runId) || manifest.length > 16384) return;
		const fd = Number(rawFd);
		if (fd < 3) return;
		const aliases: unknown = JSON.parse(manifest);
		if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return;
		const entries = Object.entries(aliases);
		if (entries.length > 128) return;
		const aliasMap = new Map<string, string>();
		const ids = new Set<string>();
		for (const [source, alias] of entries) {
			if (
				!source ||
				source.length > 1024 ||
				typeof alias !== "string" ||
				!/^ext_[0-9]{3}$/.test(alias) ||
				ids.has(alias)
			)
				return;
			aliasMap.set(source, alias);
			ids.add(alias);
		}
		// Lazy builtins: disabled mode does not import, stat, enumerate aliases, or read a clock.
		const fs = process.getBuiltinModule("node:fs");
		const stat = fs.fstatSync(fd);
		if (
			!stat.isFile() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.nlink !== 1 ||
			stat.size !== 0 ||
			(process.getuid && stat.uid !== process.getuid())
		)
			return;
		const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");
		const context = new AsyncLocalStorage<number>();
		const origin = process.hrtime.bigint();
		let last = 0n;
		let seq = 0;
		let nextId = 0;
		let bytes = 0;
		let invalid = false;
		let finished = false;
		const active = new Map<number, Span>();
		const emit = (
			phase: StartupPhase,
			event: "begin" | "end" | "mark",
			id: number,
			span: Span,
			status?: Status,
		): void => {
			if (invalid || finished) return;
			const now = process.hrtime.bigint() - origin;
			if (
				now < last ||
				!phases.includes(phase) ||
				(status !== undefined && !statuses.includes(status)) ||
				seq >= 511
			) {
				invalid = true;
				return;
			}
			last = now;
			const record = `${JSON.stringify({
				schema: "startup-trace-v1",
				seq: ++seq,
				clock: "node.hrtime.bigint",
				run_id: runId,
				span_id: id,
				parent_span_id: span.parent,
				phase,
				event,
				t_ns: now.toString(),
				...(status ? { status } : {}),
				...(span.alias ? { extension_id: span.alias } : {}),
			})}\n`;
			const size = Buffer.byteLength(record);
			if (size > 1024 || bytes + size > 256 * 1024 - 1024) {
				invalid = true;
				return;
			}
			try {
				// One bounded write, no retry or buffering; caller retains descriptor ownership.
				if (fs.writeSync(fd, record) !== size) invalid = true;
				bytes += size;
			} catch {
				invalid = true;
			}
		};
		const spanFor = (phase: StartupPhase, extension?: string): Span => {
			const alias = extension === undefined ? undefined : aliasMap.get(extension);
			if (extension !== undefined && alias === undefined) invalid = true;
			const parent = context.getStore();
			return { phase, parent: parent !== undefined && active.has(parent) ? parent : null, alias };
		};
		const trace: Trace = {
			begin(phase, extension) {
				if (invalid || finished) return 0;
				const span = spanFor(phase, extension);
				const id = ++nextId;
				active.set(id, span);
				emit(phase, "begin", id, span);
				return id;
			},
			end(id, status) {
				if (invalid || finished) return;
				const span = active.get(id);
				if (!span) {
					invalid = true;
					return;
				}
				emit(span.phase, "end", id, span, status);
				active.delete(id);
			},
			mark(phase, status, extension) {
				if (invalid || finished) return;
				emit(phase, "mark", ++nextId, spanFor(phase, extension), status);
			},
			run: (id, action) => context.run(id, action),
			finish() {
				if (finished) return;
				if (active.size > 0) invalid = true;
				// A successful trailer is mandatory. Its absence (including write/cap failure) invalidates the whole trace.
				if (!invalid) emit("trace.complete", "mark", ++nextId, { phase: "trace.complete", parent: null }, "ok");
				finished = true;
			},
		};
		host[key] = trace;
		process.once("exit", () => trace.finish());
		return trace;
	} catch {
		return;
	}
}

/** Run a real asynchronous boundary, retaining independent span identities across concurrency. */
export function traceStartup<T>(phase: StartupPhase, action: () => Promise<T>, extension?: string): Promise<T> {
	const trace = getTrace();
	if (!trace) return action();
	const id = trace.begin(phase, extension);
	return trace.run(id, async () => {
		let status: Status = "error";
		try {
			const value = await action();
			status = "ok";
			return value;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") status = "cancelled";
			throw error;
		} finally {
			trace.end(id, status);
		}
	});
}

/** Install optional observer seams only for a preflighted trace. */
export function startupTraceEnabled(): boolean {
	return getTrace() !== undefined;
}

/** Single-state observations are not manufactured zero-duration spans. */
export function markStartup(phase: StartupPhase, status: Status = "ok", extension?: string): void {
	getTrace()?.mark(phase, status, extension);
}

/** The generated launcher calls this before compile-cache activation and runtime evaluation. */
export function beginBootstrap(): void {
	const trace = getTrace();
	if (!trace) return;
	const id = trace.begin("core.bootstrap");
	bootstrapHost[bootstrapKey] = id;
}
const bootstrapKey = Symbol.for("pi.startup-trace-v1.bootstrap");
const bootstrapHost = globalThis as typeof globalThis & { [bootstrapKey]?: number };

/** Source/SDK launches without the generated wrapper have no measured bootstrap span. */
export function endBootstrap(): void {
	const id = bootstrapHost[bootstrapKey];
	if (id !== undefined) {
		getTrace()?.end(id, "ok");
		delete bootstrapHost[bootstrapKey];
	} else markStartup("core.bootstrap", "skipped");
}
