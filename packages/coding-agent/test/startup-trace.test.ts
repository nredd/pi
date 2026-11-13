import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/startup-trace-producer.ts", import.meta.url));
const sdkFixture = fileURLToPath(new URL("./fixtures/startup-trace-sdk.mjs", import.meta.url));
const launcher = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));
interface RecordEntry {
	schema: string;
	seq: number;
	clock: string;
	run_id: string;
	span_id: number;
	parent_span_id: number | null;
	phase: string;
	event: string;
	t_ns: string;
	status?: string;
	extension_id?: string;
}
function launch(
	scenario: string,
	overrides: NodeJS.ProcessEnv = {},
	options: { disabled?: boolean; mode?: number; pipe?: boolean } = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-trace-")));
	const file = join(root, "trace.jsonl");
	const fd = openSync(file, "wx+", options.mode ?? 0o600);
	try {
		const argv =
			scenario === "sdk" ? [sdkFixture] : scenario === "launcher" ? [launcher, "--version"] : [fixture, scenario];
		const child = spawnSync(process.execPath, argv, {
			cwd: root,
			timeout: 15000,
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			env: {
				...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
				PATH: process.env.PATH,
				HOME: root,
				TMPDIR: root,
				...(options.disabled
					? {}
					: {
							PI_STARTUP_TRACE_FD: "3",
							PI_STARTUP_TRACE_RUN_ID: "a".repeat(32),
							PI_STARTUP_TRACE_ALIASES: JSON.stringify({
								fixture: "ext_000",
								[join(root, "extension.mjs")]: "ext_001",
								"<inline:1>": "ext_002",
								[join(root, "factory-failure.mjs")]: "ext_003",
								[join(root, "import-failure.mjs")]: "ext_004",
							}),
							PI_OFFLINE: "1",
							PI_NO_LOCAL_LLM: "1",
							AWS_EC2_METADATA_DISABLED: "true",
						}),
				...overrides,
			},
			stdio: ["ignore", "pipe", "pipe", options.pipe ? "pipe" : fd],
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const raw = readFileSync(file, "utf8");
		const records = raw.trim()
			? raw
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as RecordEntry)
			: [];
		return { raw, records };
	} finally {
		closeSync(fd);
		rmSync(root, { recursive: true, force: true });
	}
}

// nredd/pi#51: the producer must never expose source data or turn incomplete measurements into zero.
describe("startup trace producer", () => {
	it("does no builtin, descriptor, clock, enumeration or timer work when disabled", () => {
		expect(launch("disabled", {}, { disabled: true }).raw).toBe("");
	});
	it("writes ordered, paired, concurrent spans with allowlisted fields and synthetic aliases", () => {
		const { raw, records } = launch("valid");
		expect(raw).not.toMatch(/PRIVATE_ERROR|fixture|\/unmapped/);
		expect(records.at(-1)?.phase).toBe("trace.complete");
		const open = new Map<number, RecordEntry>();
		const seen = new Set<number>();
		let last = 0n;
		for (const [index, record] of records.entries()) {
			expect(record.seq).toBe(index + 1);
			expect(record.schema).toBe("startup-trace-v1");
			expect(record.clock).toBe("node.hrtime.bigint");
			expect(record.run_id).toBe("a".repeat(32));
			expect(BigInt(record.t_ns)).toBeGreaterThanOrEqual(last);
			last = BigInt(record.t_ns);
			if (record.parent_span_id !== null) expect(open.has(record.parent_span_id)).toBe(true);
			if (record.event === "end") {
				expect(open.get(record.span_id)?.phase).toBe(record.phase);
				open.delete(record.span_id);
			} else {
				expect(seen.has(record.span_id)).toBe(false);
				seen.add(record.span_id);
				if (record.event === "begin") open.set(record.span_id, record);
			}
			expect(Buffer.byteLength(JSON.stringify(record)) + 1).toBeLessThanOrEqual(1024);
			expect(Object.keys(record).sort()).toEqual(
				[
					"schema",
					"seq",
					"clock",
					"run_id",
					"span_id",
					"parent_span_id",
					"phase",
					"event",
					"t_ns",
					...(record.status ? ["status"] : []),
					...(record.extension_id ? ["extension_id"] : []),
				].sort(),
			);
		}
		expect(open.size).toBe(0);
		expect(records.filter((r) => r.phase === "session.handlers" && r.event === "begin")).toHaveLength(2);
		expect(records.some((r) => r.status === "error")).toBe(true);
		expect(records.some((r) => r.status === "cancelled")).toBe(true);
		expect(records.some((r) => r.status === "cached" && r.extension_id === "ext_000")).toBe(true);
	});
	it("exercises bundled services, compiled faux SDK and both virtual renderers", () => {
		const { records, raw } = launch("sdk");
		expect(raw).not.toMatch(/private|synthetic input|extension\.mjs|probe/);
		expect(records.at(-1)?.phase).toBe("trace.complete");
		for (const phase of [
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
		]) {
			expect(
				records.some((r) => r.phase === phase),
				phase,
			).toBe(true);
		}
		expect(records.filter((r) => r.phase === "tui.first_commit")).toHaveLength(2);
		expect(records.some((r) => r.phase === "session.handlers" && r.status === "error")).toBe(true);
		expect(records.some((r) => r.status === "reused")).toBe(true);
		expect(records.some((r) => r.status === "cached")).toBe(true);
	});
	it("starts bootstrap before the compiled launcher runtime and ends it at main entry", () => {
		const { records } = launch("launcher");
		expect(records[0]).toMatchObject({ phase: "core.bootstrap", event: "begin" });
		expect(records[1]).toMatchObject({ phase: "core.bootstrap", event: "end", span_id: records[0].span_id });
		expect(records.at(-1)?.phase).toBe("trace.complete");
	});
	it.each(["overflow", "alias", "write-failure", "nonmonotonic", "missing", "duplicate"])(
		"invalidates %s without wedging startup",
		(scenario) => {
			const { raw, records } = launch(scenario);
			expect(records.some((r) => r.phase === "trace.complete")).toBe(false);
			expect(records.length).toBeLessThanOrEqual(512);
			expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(256 * 1024);
		},
	);
	it.each(["0", "1", "2", "-3", "3.0", "3x", "999999", ""])("rejects malformed or unavailable descriptor %s", (fd) => {
		expect(launch("valid", { PI_STARTUP_TRACE_FD: fd }).raw).toBe("");
	});
	it("rejects a pipe descriptor without writing or waiting", () => {
		expect(launch("valid", {}, { pipe: true }).raw).toBe("");
	});
	it("rejects nonprivate regular files", () => {
		expect(launch("valid", {}, { mode: 0o644 }).raw).toBe("");
	});
	it.each(["null", "[]", "{", '{"x":"PRIVATE"}', '{"x":"ext_000","y":"ext_000"}', "x".repeat(16385)])(
		"rejects malformed alias manifests",
		(manifest) => {
			expect(launch("valid", { PI_STARTUP_TRACE_ALIASES: manifest }).raw).toBe("");
		},
	);
});
