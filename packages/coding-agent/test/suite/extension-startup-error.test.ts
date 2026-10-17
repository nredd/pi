import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { VIRTUAL_MODULES } from "../../src/core/extensions/virtual-modules.ts";
import { ExtensionStartupError } from "../../src/index.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

/** An extension whose `session_start` throws `thrown()` while `armed` is set. */
function startupExtension(state: { armed: boolean }, thrown: () => unknown) {
	return (pi: { on: (event: "session_start", handler: () => void) => void }) => {
		pi.on("session_start", () => {
			if (state.armed) throw thrown();
		});
	};
}

describe("ExtensionStartupError", () => {
	const harnesses: Harness[] = [];

	async function harnessWith(...args: Parameters<typeof createHarness>): Promise<Harness> {
		const harness = await createHarness(...args);
		harnesses.push(harness);
		return harness;
	}

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	describe("public SDK", () => {
		it("is an Error named ExtensionStartupError that keeps its cause", () => {
			const cause = new Error("inner");
			const error = new ExtensionStartupError("outer", { cause });
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe("ExtensionStartupError");
			expect(error.message).toBe("outer");
			expect(error.cause).toBe(cause);
		});

		it.each(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"])(
			"is exported by the compiled-binary alias %s",
			(name) => {
				const sdk = VIRTUAL_MODULES[name] as { ExtensionStartupError?: unknown };
				expect(sdk.ExtensionStartupError).toBe(ExtensionStartupError);
			},
		);
	});

	describe("session_start", () => {
		it("rejects bindExtensions with the extension path and cause before any provider request", async () => {
			const cause = new ExtensionStartupError("untrusted project file is malformed");
			const harness = await harnessWith({
				extensionFactories: [startupExtension({ armed: true }, () => cause)],
			});
			const onError = vi.fn();

			const failure = await harness.session.bindExtensions({ mode: "print", onError }).catch((error) => error);

			expect(failure).toBeInstanceOf(ExtensionStartupError);
			expect(failure.message).toContain("Extension startup failed");
			expect(failure.message).toContain("untrusted project file is malformed");
			expect(failure.cause).toBe(cause);
			expect(onError).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("skips later session_start handlers once one is fatal", async () => {
			const later = vi.fn();
			const harness = await harnessWith({
				extensionFactories: [
					startupExtension({ armed: true }, () => new ExtensionStartupError("stop")),
					(pi) => {
						pi.on("session_start", later);
					},
				],
			});

			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toBeInstanceOf(ExtensionStartupError);
			expect(later).not.toHaveBeenCalled();
		});

		it("keeps ordinary errors logged and nonfatal", async () => {
			const later = vi.fn();
			const harness = await harnessWith({
				extensionFactories: [
					startupExtension({ armed: true }, () => new Error("ordinary")),
					(pi) => {
						pi.on("session_start", later);
					},
				],
			});
			const onError = vi.fn();
			harness.setResponses([fauxAssistantMessage("hi")]);

			await harness.session.bindExtensions({ mode: "print", onError });
			await harness.session.prompt("hello");

			expect(onError).toHaveBeenCalledWith(expect.objectContaining({ event: "session_start", error: "ordinary" }));
			expect(later).toHaveBeenCalledTimes(1);
			expect(harness.faux.state.callCount).toBe(1);
		});

		it("treats a thrown ExtensionStartupError on any other event as an ordinary error", async () => {
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", () => {
							throw new ExtensionStartupError("not at startup");
						});
					},
				],
			});
			const onError = vi.fn();
			await harness.session.bindExtensions({ mode: "print", onError });

			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ event: "session_shutdown", error: "not at startup" }),
			);
		});
	});

	describe("failed-startup latch", () => {
		it("refuses every request path until a bind succeeds", async () => {
			const state = { armed: true };
			const harness = await harnessWith({
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("bad"))],
			});
			harness.setResponses([fauxAssistantMessage("after recovery")]);

			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toBeInstanceOf(ExtensionStartupError);

			await expect(harness.session.prompt("hi")).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.sendUserMessage("hi")).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.compact()).rejects.toBeInstanceOf(ExtensionStartupError);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.messages).toEqual([]);

			state.armed = false;
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("hi");

			expect(harness.faux.state.callCount).toBe(1);
		});

		it("stays latched when a retried bind fails again", async () => {
			const harness = await harnessWith({
				extensionFactories: [startupExtension({ armed: true }, () => new ExtensionStartupError("bad"))],
			});

			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toBeInstanceOf(ExtensionStartupError);

			await expect(harness.session.prompt("hi")).rejects.toBeInstanceOf(ExtensionStartupError);
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("latches a fatal reload and clears on the next successful reload", async () => {
			const state = { armed: false };
			const harness = await harnessWith({
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("bad reload"))],
			});
			await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

			state.armed = true;
			await expect(harness.session.reload()).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.prompt("hi")).rejects.toBeInstanceOf(ExtensionStartupError);
			expect(harness.faux.state.callCount).toBe(0);

			state.armed = false;
			await harness.session.reload();
			// reload() resets API providers. Restore the test transport and prove a real successful request.
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("after reload")]);
				await harness.session.prompt("hi");
				expect(recoveredProvider.state.callCount).toBe(1);
				const reply = harness.session.messages.findLast((message) => message.role === "assistant");
				expect(reply).toMatchObject({
					stopReason: "stop",
					content: [{ type: "text", text: "after reload" }],
				});
			} finally {
				recoveredProvider.unregister();
			}
		});

		it("refuses summarizing navigateTree while latched but allows it after recovery", async () => {
			const state = { armed: false };
			const harness = await harnessWith({
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("bad reload"))],
			});
			harness.setResponses([fauxAssistantMessage("first")]);
			await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
			await harness.session.prompt("hi");
			const firstUser = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
			expect(firstUser).toBeDefined();
			const callsBefore = harness.faux.state.callCount;

			state.armed = true;
			await expect(harness.session.reload()).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.navigateTree(firstUser?.id ?? "", { summarize: true })).rejects.toBeInstanceOf(
				ExtensionStartupError,
			);
			expect(harness.faux.state.callCount).toBe(callsBefore);

			state.armed = false;
			await harness.session.reload();
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("recovered branch summary")]);
				const result = await harness.session.navigateTree(firstUser?.id ?? "", { summarize: true });
				expect(recoveredProvider.state.callCount).toBe(1);
				expect(result.cancelled).toBe(false);
				expect(result.summaryEntry?.summary).toContain("recovered branch summary");
			} finally {
				recoveredProvider.unregister();
			}
		});

		it.each([
			["mode-only", { mode: "print" as const }],
			["empty", {}],
		])("latches a fatal reload after %s bindings and recovers on the next reload", async (_name, bindings) => {
			const state = { armed: false };
			const harness = await harnessWith({
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("bad reload"))],
			});
			await harness.session.bindExtensions(bindings);

			state.armed = true;
			await expect(harness.session.reload()).rejects.toBeInstanceOf(ExtensionStartupError);
			await expect(harness.session.prompt("hi")).rejects.toBeInstanceOf(ExtensionStartupError);
			expect(harness.faux.state.callCount).toBe(0);

			state.armed = false;
			await harness.session.reload();
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("after reload")]);
				await harness.session.prompt("hi");
				expect(recoveredProvider.state.callCount).toBe(1);
			} finally {
				recoveredProvider.unregister();
			}
		});

		it("does not emit session_start on reload before any bindExtensions call", async () => {
			const handler = vi.fn();
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", handler);
					},
				],
			});

			await harness.session.reload();

			expect(handler).not.toHaveBeenCalled();
		});

		it("does not latch ordinary startup errors", async () => {
			const harness = await harnessWith({
				extensionFactories: [startupExtension({ armed: true }, () => new Error("ordinary"))],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);

			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("hi");

			expect(harness.faux.state.callCount).toBe(1);
		});
	});

	describe("pending startup", () => {
		const later = (state: { fatal: boolean }) => (pi: ExtensionAPI) => {
			pi.on("session_start", async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (state.fatal) throw new ExtensionStartupError("late async failure");
			});
		};

		it("never contacts the provider for a startup message when a later async handler is fatal", async () => {
			const state = { fatal: true };
			let sent = false;
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							if (sent) return;
							sent = true;
							pi.sendUserMessage("queued during startup");
							pi.sendMessage(
								{ customType: "note", content: "queued note", display: true },
								{ triggerTurn: true },
							);
						});
					},
					later(state),
				],
			});
			harness.setResponses([fauxAssistantMessage("must not be requested")]);
			const errors: string[] = [];

			await expect(
				harness.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.event) }),
			).rejects.toBeInstanceOf(ExtensionStartupError);
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.messages).toEqual([]);
			expect(harness.session.isStreaming).toBe(false);
			expect(errors).toEqual(["send_user_message", "send_message"]);

			// Recovery does not resurrect the discarded messages.
			state.fatal = false;
			await harness.session.bindExtensions({ mode: "print" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("runs a startup message once session_start completes", async () => {
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							pi.sendUserMessage("queued during startup");
						});
					},
					later({ fatal: false }),
				],
			});
			harness.setResponses([fauxAssistantMessage("startup reply")]);

			await harness.session.bindExtensions({ mode: "print" });
			// Deferred until the handlers finish, so nothing was requested before bind returned.
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
			await harness.session.waitForIdle();

			expect(harness.session.messages.map((message) => message.role).filter((role) => role !== "system")).toEqual([
				"user",
				"assistant",
			]);
		});

		it("still delivers a startup message after an ordinary later error", async () => {
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							pi.sendUserMessage("queued during startup");
						});
					},
					startupExtension({ armed: true }, () => new Error("ordinary")),
				],
			});
			harness.setResponses([fauxAssistantMessage("startup reply")]);

			await harness.session.bindExtensions({ mode: "print", onError: () => {} });
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		});

		it("refuses direct SDK requests while session_start is pending", async () => {
			let release: (() => void) | undefined;
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							return new Promise<void>((resolve) => {
								release = resolve;
							});
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("after startup")]);

			const binding = harness.session.bindExtensions({ mode: "print" });
			await expect(harness.session.prompt("early")).rejects.toThrow("still starting");
			await expect(harness.session.compact()).rejects.toThrow("still starting");
			expect(harness.faux.state.callCount).toBe(0);

			release?.();
			await binding;
			await harness.session.prompt("later");
			expect(harness.faux.state.callCount).toBe(1);
		});

		it("refuses ctx.compact() during session_start through onError", async () => {
			const onError = vi.fn();
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (_event, ctx) => {
							ctx.compact({ onError });
						});
					},
				],
			});

			await harness.session.bindExtensions({ mode: "print" });

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("session_start") }),
			);
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("discards a startup message from a failed reload", async () => {
			const state = { fatal: false };
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (event) => {
							if (event.reason === "reload") pi.sendUserMessage("queued during reload");
						});
					},
					later(state),
				],
			});
			await harness.session.bindExtensions({ mode: "print", onError: () => {} });

			state.fatal = true;
			await expect(harness.session.reload()).rejects.toBeInstanceOf(ExtensionStartupError);
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.messages).toEqual([]);
		});
	});

	describe("print mode", () => {
		it("exits nonzero, reports the failure, disposes, and never reaches the provider", async () => {
			const harness = await harnessWith({
				extensionFactories: [startupExtension({ armed: true }, () => new ExtensionStartupError("untrusted"))],
			});
			harness.setResponses([fauxAssistantMessage("must not be requested")]);
			const dispose = vi.fn(async () => {});
			const runtime = {
				session: harness.session,
				newSession: vi.fn(),
				fork: vi.fn(),
				switchSession: vi.fn(),
				dispose,
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime;
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "hello", messages: ["again"] });

			expect(exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("untrusted"));
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(harness.faux.state.callCount).toBe(0);
			errorSpy.mockRestore();
		});
	});
});
