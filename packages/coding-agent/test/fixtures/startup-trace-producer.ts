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
	process.getBuiltinModule = () => {
		throw new Error("disabled builtin access");
	};
	process.hrtime.bigint = () => {
		throw new Error("disabled clock access");
	};
	Object.entries = () => {
		throw new Error("disabled enumeration");
	};
	Object.defineProperty(globalThis, "setTimeout", {
		value: () => {
			throw new Error("disabled timer");
		},
	});
	assert.equal(startupTraceEnabled(), false);
	markStartup("session.bind.ready");
	assert.equal(await traceStartup("session.handlers", async () => 42), 42);
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
