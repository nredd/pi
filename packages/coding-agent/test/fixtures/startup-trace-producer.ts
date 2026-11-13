import assert from "node:assert/strict";
import {
	beginBootstrap,
	endBootstrap,
	markStartup,
	startupTraceEnabled,
	traceStartup,
} from "../../src/core/startup-trace.ts";

const scenario = process.argv[2];
if (scenario === "disabled") {
	const attempts = { builtins: 0, clocks: 0, enumerations: 0, timers: 0 };
	process.getBuiltinModule = () => {
		attempts.builtins++;
		throw new Error("disabled builtin access");
	};
	process.hrtime.bigint = () => {
		attempts.clocks++;
		throw new Error("disabled clock access");
	};
	Object.entries = () => {
		attempts.enumerations++;
		throw new Error("disabled enumeration");
	};
	Object.defineProperty(globalThis, "setTimeout", {
		value: () => {
			attempts.timers++;
			throw new Error("disabled timer");
		},
	});
	assert.equal(startupTraceEnabled(), false);
	markStartup("session.bind.ready");
	assert.equal(await traceStartup("session.handlers", async () => 42), 42);
	assert.deepEqual(attempts, { builtins: 0, clocks: 0, enumerations: 0, timers: 0 });
} else if (scenario?.startsWith("closed-")) {
	process.getBuiltinModule("node:fs").closeSync(Number(scenario.slice("closed-".length)));
	markStartup("session.bind.ready");
} else if (scenario === "overflow") {
	for (let i = 0; i < 1000; i++) markStartup("session.bind.ready");
} else if (scenario === "alias") {
	markStartup("extension.import", "cached", "/unmapped/private/source");
} else if (scenario === "write-failure") {
	const fs = process.getBuiltinModule("node:fs");
	markStartup("session.bind.ready");
	fs.closeSync(3);
	markStartup("session.bind.ready");
} else if (scenario === "nonmonotonic") {
	markStartup("session.bind.ready");
	process.hrtime.bigint = () => 0n;
	markStartup("session.bind.ready");
} else if (scenario === "missing") {
	beginBootstrap();
} else if (scenario === "duplicate") {
	beginBootstrap();
	beginBootstrap();
	endBootstrap();
} else {
	beginBootstrap();
	endBootstrap();
	await traceStartup("resources.reload", async () => {
		await Promise.all(
			[0, 1].map(async () =>
				traceStartup("session.handlers", async () => {
					await Promise.resolve();
					markStartup("session.bind.ready");
				}),
			),
		);
	});
	await assert.rejects(
		traceStartup(
			"extension.factory",
			async () => {
				throw new Error("PRIVATE_ERROR");
			},
			"fixture",
		),
	);
	await assert.rejects(
		traceStartup("model.catalog.initial", async () => {
			throw new DOMException("PRIVATE_ERROR", "AbortError");
		}),
	);
	markStartup("extension.import", "cached", "fixture");
}
