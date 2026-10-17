import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { ExtensionStartupError } from "../../src/index.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

afterEach(() => {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
});

describe("RPC mode with a fatal session_start failure", () => {
	it("rejects, disposes, and never starts accepting commands", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						throw new ExtensionStartupError("untrusted");
					});
				},
			],
		});
		const dispose = vi.fn(async () => {});
		const runtime = {
			session: harness.session,
			newSession: vi.fn(),
			fork: vi.fn(),
			switchSession: vi.fn(),
			dispose,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		try {
			await expect(runRpcMode(runtime)).rejects.toBeInstanceOf(ExtensionStartupError);

			expect(dispose).toHaveBeenCalledTimes(1);
			expect(rpcIo.lineHandler).toBeUndefined();
			expect(rpcIo.outputLines).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
