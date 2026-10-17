import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	contentText,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
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

		it("keeps a fatal latch when reload setup throws before session_start", async () => {
			const state = { armed: false };
			const harness = await harnessWith({
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("bad reload"))],
			});
			await harness.session.bindExtensions({ mode: "print" });

			state.armed = true;
			await expect(harness.session.reload()).rejects.toThrow("bad reload");
			await expect(
				harness.session.reload({
					beforeSessionStart: () => {
						throw new Error("reload setup failed");
					},
				}),
			).rejects.toThrow("reload setup failed");

			await expect(harness.session.prompt("still blocked")).rejects.toThrow("bad reload");
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

		it("replays multiple startup messages sequentially", async () => {
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							pi.sendUserMessage("first startup message");
							pi.sendUserMessage("second startup message");
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

			await harness.session.bindExtensions({ mode: "print" });
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
			await harness.session.waitForIdle();

			expect(harness.faux.state.callCount).toBe(2);
			expect(
				harness.session.messages
					.filter((message) => message.role === "user" || message.role === "assistant")
					.map((message) => `${message.role}:${contentText(message.content)}`),
			).toEqual([
				"user:first startup message",
				"assistant:first reply",
				"user:second startup message",
				"assistant:second reply",
			]);
		});

		it("runs a prompt issued right after the bind behind the replayed startup message", async () => {
			// Print mode prompts immediately after bindExtensions(). Before the replay existed that
			// raced the startup turn; now the prompt waits for it instead of "already processing".
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
			harness.setResponses([fauxAssistantMessage("startup reply"), fauxAssistantMessage("prompt reply")]);

			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("from the caller");

			expect(harness.faux.state.callCount).toBe(2);
			const conversation = harness.session.messages
				.filter((message) => message.role === "user" || message.role === "assistant")
				.map((message) => `${message.role}:${contentText(message.content)}`);
			expect(conversation).toEqual([
				"user:queued during startup",
				"assistant:startup reply",
				"user:from the caller",
				"assistant:prompt reply",
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

		it("waits for pending reload startup before an in-flight turn's next request", async () => {
			let releaseTool: (() => void) | undefined;
			let toolStarted: (() => void) | undefined;
			const toolRan = new Promise<void>((resolve) => {
				toolStarted = resolve;
			});
			let releaseStartup: (() => void) | undefined;
			let reloadStarted: (() => void) | undefined;
			const startupPending = new Promise<void>((resolve) => {
				reloadStarted = resolve;
			});
			const waitTool: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Waits for the test",
				parameters: Type.Object({}),
				execute: async () => {
					toolStarted?.();
					await new Promise<void>((resolve) => {
						releaseTool = resolve;
					});
					return { content: [], details: {} };
				},
			};
			const harness = await harnessWith({
				tools: [waitTool],
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (event) => {
							if (event.reason !== "reload") return;
							reloadStarted?.();
							await new Promise<void>((resolve) => {
								releaseStartup = resolve;
							});
						});
					},
				],
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("after reload"),
			]);
			await harness.session.bindExtensions({ mode: "print" });

			const prompt = harness.session.prompt("start");
			await toolRan;
			const reload = harness.session.reload();
			await startupPending;
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("after reload")]);
				releaseTool?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(recoveredProvider.state.callCount).toBe(0);

				releaseStartup?.();
				await reload;
				await prompt;
				expect(recoveredProvider.state.callCount).toBe(1);
			} finally {
				recoveredProvider.unregister();
			}
		});

		it("rechecks the startup latch after context handlers before streaming", async () => {
			const state = { fatal: false };
			let releaseContext: (() => void) | undefined;
			let contextStarted: (() => void) | undefined;
			const contextPending = new Promise<void>((resolve) => {
				contextStarted = resolve;
			});
			let releaseStartup: (() => void) | undefined;
			let reloadStarted: (() => void) | undefined;
			const startupPending = new Promise<void>((resolve) => {
				reloadStarted = resolve;
			});
			const harness = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (event) => {
							if (event.reason !== "reload") return;
							reloadStarted?.();
							await new Promise<void>((resolve) => {
								releaseStartup = resolve;
							});
							if (state.fatal) throw new ExtensionStartupError("fatal reload");
						});
						pi.on("context", async () => {
							contextStarted?.();
							await new Promise<void>((resolve) => {
								releaseContext = resolve;
							});
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("must not stream")]);
			await harness.session.bindExtensions({ mode: "print" });

			const prompt = harness.session.prompt("start");
			await contextPending;
			state.fatal = true;
			const reload = harness.session.reload();
			await startupPending;
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("must not stream")]);
				releaseContext?.();
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(recoveredProvider.state.callCount).toBe(0);
				releaseStartup?.();
				await expect(reload).rejects.toBeInstanceOf(ExtensionStartupError);
				await prompt;
				expect(recoveredProvider.state.callCount).toBe(0);
			} finally {
				recoveredProvider.unregister();
			}
		});

		it("does not send after auth resolution when a fatal bind settles", async () => {
			const state = { fatal: false };
			let releaseAuth: (() => void) | undefined;
			let authStarted: (() => void) | undefined;
			const authPending = new Promise<void>((resolve) => {
				authStarted = resolve;
			});
			const harness = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							if (state.fatal) {
								throw new ExtensionStartupError("fatal reload");
							}
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "print" });
			const originalGetAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
			vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (...args) => {
				authStarted?.();
				await new Promise<void>((resolve) => {
					releaseAuth = resolve;
				});
				return originalGetAuth(...args);
			});
			harness.setResponses([fauxAssistantMessage("must not stream")]);

			const prompt = harness.session.prompt("start");
			await authPending;
			state.fatal = true;
			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toThrow("fatal reload");
			releaseAuth?.();
			await prompt;

			expect(harness.faux.state.callCount).toBe(0);
		});

		it("does not send a compaction summary paused in auth when a fatal reload settles", async () => {
			// Summaries build their own request options outside the agent loop; they must carry
			// the same last-moment gate as a conversational request.
			const state = { fatal: false };
			let releaseAuth: (() => void) | undefined;
			let authStarted: (() => void) | undefined;
			const authPending = new Promise<void>((resolve) => {
				authStarted = resolve;
			});
			const harness = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							if (state.fatal) throw new ExtensionStartupError("fatal reload");
						});
					},
				],
			});
			await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
			harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
			const now = Date.now();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "message to compact" }],
				timestamp: now - 1000,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
				model: harness.getModel().id,
				provider: harness.getModel().provider,
				usage: {
					input: 50,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			// Pause inside the request-header transform, after auth resolved, like the SDK's
			// before_provider_headers hook would.
			const stream = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = (model, context, options) =>
				stream(model, context, {
					...options,
					transformHeaders: async (headers: ProviderHeaders) => {
						authStarted?.();
						await new Promise<void>((resolve) => {
							releaseAuth = resolve;
						});
						return headers;
					},
				} satisfies ModelsSimpleStreamOptions as typeof options);
			harness.setResponses([fauxAssistantMessage("summary that must not stream")]);

			const compaction = harness.session.compact().then(
				() => undefined,
				(error) => error,
			);
			await authPending;
			state.fatal = true;
			await expect(harness.session.reload()).rejects.toThrow("fatal reload");
			releaseAuth?.();
			await compaction;

			expect(harness.faux.state.callCount).toBe(0);
		});

		it("holds a compaction summary paused in the header transform while a reload is pending", async () => {
			// No abort fires for a reload that merely takes time, so only the request's own gate
			// keeps the summary from dispatching before the handlers finish.
			let finishStartup: (() => void) | undefined;
			const state = { slow: false };
			let releaseTransform: (() => void) | undefined;
			let transformStarted: (() => void) | undefined;
			const transformPending = new Promise<void>((resolve) => {
				transformStarted = resolve;
			});
			const harness = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							if (!state.slow) return;
							await new Promise<void>((resolve) => {
								finishStartup = resolve;
							});
						});
					},
				],
			});
			await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
			harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
			const now = Date.now();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "message to compact" }],
				timestamp: now - 1000,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
				model: harness.getModel().id,
				provider: harness.getModel().provider,
				usage: {
					input: 50,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const stream = harness.session.agent.streamFunction;
			harness.session.agent.streamFunction = (model, context, options) =>
				stream(model, context, {
					...options,
					transformHeaders: async (headers: ProviderHeaders) => {
						transformStarted?.();
						await new Promise<void>((resolve) => {
							releaseTransform = resolve;
						});
						return headers;
					},
				} satisfies ModelsSimpleStreamOptions as typeof options);
			harness.setResponses([fauxAssistantMessage("summary")]);

			const compaction = harness.session.compact();
			await transformPending;
			state.slow = true;
			const reload = harness.session.reload();
			await vi.waitFor(() => expect(finishStartup).toBeDefined());
			// reload() reset the API providers; the summary needs a transport to reach once allowed.
			const recoveredProvider = registerFauxProvider({ api: harness.faux.api });
			try {
				recoveredProvider.setResponses([fauxAssistantMessage("summary")]);
				releaseTransform?.();
				// Give the summary every chance to dispatch while the handler is still running.
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(recoveredProvider.state.callCount).toBe(0);
				expect(harness.faux.state.callCount).toBe(0);

				finishStartup?.();
				await reload;
				await compaction;
				expect(recoveredProvider.state.callCount).toBe(1);
			} finally {
				recoveredProvider.unregister();
			}
		});

		it("binds the last-moment gate to the requesting session", async () => {
			const state = { armed: false };
			const first = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [startupExtension(state, () => new ExtensionStartupError("fatal reload"))],
			});
			await first.session.bindExtensions({ mode: "print" });
			const second = await harnessWith({ modelRuntime: first.session.modelRuntime, useModelRuntimeStream: true });
			await second.session.bindExtensions({ mode: "print" });
			let releaseAuth: (() => void) | undefined;
			let authStarted: (() => void) | undefined;
			const authPending = new Promise<void>((resolve) => {
				authStarted = resolve;
			});
			const originalGetAuth = first.session.modelRuntime.getAuth.bind(first.session.modelRuntime);
			const getAuth = vi.spyOn(first.session.modelRuntime, "getAuth").mockImplementation(async (...args) => {
				authStarted?.();
				await new Promise<void>((resolve) => {
					releaseAuth = resolve;
				});
				return originalGetAuth(...args);
			});
			const firstPrompt = first.session.prompt("A");
			await authPending;
			state.armed = true;
			await expect(first.session.bindExtensions({ mode: "print" })).rejects.toThrow("fatal reload");
			releaseAuth?.();
			await firstPrompt;
			getAuth.mockRestore();
			expect(second.faux.state.callCount).toBe(0);

			second.setResponses([fauxAssistantMessage("B")]);
			await second.session.prompt("B");
			expect(second.faux.state.callCount).toBe(1);
		});

		it("encodes model-registry startup refusal in its documented result types", async () => {
			const results: Array<{ stopReason: string; errorMessage?: string }> = [];
			let chatModel: Model<string> | undefined;
			let providerCalls = 0;
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							const classifier = ctx.modelRegistry.findOfType("classifier", "startup-operations", "classifier")!;
							const chat = chatModel!;
							const image = ctx.modelRegistry.findOfType("image", "startup-operations", "image")!;
							results.push(
								await ctx.modelRegistry.stream(chat, { messages: [] }).result(),
								await ctx.modelRegistry.streamSimple(chat, { messages: [] }).result(),
								await ctx.modelRegistry.complete(chat, { messages: [] }),
								await ctx.modelRegistry.classify(classifier, {
									state: {},
									questions: {
										allowed: { type: "bool", instructions: "Allowed?", criteria: { true: "", false: "" } },
									},
								}),
								await ctx.modelRegistry.generateImages(image, { input: [{ type: "text", text: "test" }] }),
							);
						});
					},
					startupExtension({ armed: true }, () => new ExtensionStartupError("later failure")),
				],
			});
			chatModel = harness.getModel();
			harness.session.modelRuntime.registerProvider("startup-operations", {
				apiKey: "secret",
				baseUrl: "https://startup.test/v1",
				models: [
					{
						id: "classifier",
						name: "Classifier",
						type: "classifier",
						api: "test-classifier",
						input: ["text"],
						contextWindow: 1000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{
						id: "image",
						name: "Image",
						type: "image",
						api: "test-images",
						input: ["text"],
						output: ["image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
				classifiers: {
					"test-classifier": {
						classify: async () => {
							providerCalls++;
							throw new Error("provider must not be called");
						},
					},
				},
				images: {
					"test-images": {
						generateImages: async () => {
							providerCalls++;
							throw new Error("provider must not be called");
						},
					},
				},
			});

			await expect(harness.session.bindExtensions({ mode: "print" })).rejects.toThrow("later failure");
			expect(results).toHaveLength(5);
			for (const result of results) {
				expect(result).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringContaining("still starting"),
				});
			}
			expect(providerCalls).toBe(0);
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("waits for each held action when a new startup begins during replay", async () => {
			let emission = 0;
			let releaseFirst: (() => void) | undefined;
			let firstRequest: (() => void) | undefined;
			const firstInFlight = new Promise<void>((resolve) => {
				firstRequest = resolve;
			});
			let releaseSecondStartup: (() => void) | undefined;
			let secondStartupStarted: (() => void) | undefined;
			const secondStartupPending = new Promise<void>((resolve) => {
				secondStartupStarted = resolve;
			});
			const errors: string[] = [];
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							emission++;
							if (emission === 1) {
								pi.sendUserMessage("A");
								pi.sendUserMessage("B");
								return;
							}
							secondStartupStarted?.();
							await new Promise<void>((resolve) => {
								releaseSecondStartup = resolve;
							});
						});
					},
				],
			});
			harness.setResponses([
				async () => {
					firstRequest?.();
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
					return fauxAssistantMessage("A reply");
				},
				fauxAssistantMessage("B reply"),
			]);

			await harness.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
			await firstInFlight;
			const secondBind = harness.session.bindExtensions({ mode: "print" });
			await secondStartupPending;
			releaseFirst?.();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(harness.faux.state.callCount).toBe(1);

			releaseSecondStartup?.();
			await secondBind;
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
			await harness.session.waitForIdle();
			expect(errors).not.toContain(expect.stringContaining("still starting"));
			expect(
				harness.session.messages
					.filter((message) => message.role === "user")
					.map((message) => contentText(message.content)),
			).toEqual(["A", "B"]);
		});

		it("rechecks startup synchronously when a bind queues as the provider gate resolves", async () => {
			const state = { slow: false };
			let releaseStartup: (() => void) | undefined;
			let startupStarted: (() => void) | undefined;
			const startupPending = new Promise<void>((resolve) => {
				startupStarted = resolve;
			});
			const harness = await harnessWith({
				useModelRuntimeStream: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							if (!state.slow) return;
							startupStarted?.();
							await new Promise<void>((resolve) => {
								releaseStartup = resolve;
							});
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("must not dispatch")]);
			await harness.session.bindExtensions({ mode: "print" });
			state.slow = true;
			const gate = harness.session.agent.beforeProviderRequest!;
			let queuedBind: Promise<void> | undefined;
			harness.session.agent.beforeProviderRequest = async () => {
				const recheck = await gate();
				queueMicrotask(() => {
					queuedBind = harness.session.bindExtensions({ mode: "print" });
				});
				return recheck;
			};

			const prompt = harness.session.prompt("race startup");
			await startupPending;
			expect(harness.faux.state.callCount).toBe(0);
			releaseStartup?.();
			await queuedBind;
			await prompt;
		});

		it("chains overlapping startup replay batches in order", async () => {
			let emission = 0;
			let releaseFirst: (() => void) | undefined;
			let firstRequest: (() => void) | undefined;
			const firstInFlight = new Promise<void>((resolve) => {
				firstRequest = resolve;
			});
			const errors: string[] = [];
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							emission++;
							pi.sendUserMessage(emission === 1 ? "first" : "second");
						});
					},
				],
			});
			harness.setResponses([
				async () => {
					firstRequest?.();
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
					return fauxAssistantMessage("first reply");
				},
				fauxAssistantMessage("second reply"),
			]);

			await harness.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.event) });
			await firstInFlight;
			await harness.session.bindExtensions({ mode: "print" });
			releaseFirst?.();
			await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
			await harness.session.waitForIdle();
			expect(errors).not.toContain("send_user_message");
			expect(
				harness.session.messages
					.filter((message) => message.role === "user")
					.map((message) => contentText(message.content)),
			).toEqual(["first", "second"]);
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

	describe("overlapping startup", () => {
		it("does not let a reload entered before a fatal settles recover it", async () => {
			let emission = 0;
			let releaseFailure: (() => void) | undefined;
			let failureStarted: (() => void) | undefined;
			const failurePending = new Promise<void>((resolve) => {
				failureStarted = resolve;
			});
			let releaseSettingsReload: (() => void) | undefined;
			let settingsReloadStarted: (() => void) | undefined;
			const settingsReloadPending = new Promise<void>((resolve) => {
				settingsReloadStarted = resolve;
			});
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							emission++;
							if (emission !== 2) return;
							failureStarted?.();
							await new Promise<void>((resolve) => {
								releaseFailure = resolve;
							});
							throw new ExtensionStartupError("late failure");
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "print" });
			const originalReload = harness.settingsManager.reload.bind(harness.settingsManager);
			vi.spyOn(harness.settingsManager, "reload").mockImplementation(async () => {
				settingsReloadStarted?.();
				await new Promise<void>((resolve) => {
					releaseSettingsReload = resolve;
				});
				await originalReload();
			});

			const failedBind = harness.session.bindExtensions({ mode: "print" });
			await failurePending;
			const reload = harness.session.reload();
			await settingsReloadPending;
			releaseFailure?.();
			await expect(failedBind).rejects.toThrow("late failure");
			releaseSettingsReload?.();
			await reload;

			await expect(harness.session.prompt("still blocked")).rejects.toThrow("late failure");
		});

		it("discards a fatal emission's held messages before overlapping startup settles", async () => {
			let emission = 0;
			let releaseFailure: (() => void) | undefined;
			let failureStarted: (() => void) | undefined;
			const failurePending = new Promise<void>((resolve) => {
				failureStarted = resolve;
			});
			let releaseSuccess: (() => void) | undefined;
			let successStarted: (() => void) | undefined;
			const successPending = new Promise<void>((resolve) => {
				successStarted = resolve;
			});
			const errors: string[] = [];
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							emission++;
							if (emission === 2) {
								pi.sendUserMessage("discard me");
								failureStarted?.();
								await new Promise<void>((resolve) => {
									releaseFailure = resolve;
								});
								throw new ExtensionStartupError("late failure");
							}
							if (emission === 3) {
								successStarted?.();
								await new Promise<void>((resolve) => {
									releaseSuccess = resolve;
								});
							}
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.event) });

			const failedBind = harness.session.bindExtensions({ mode: "print" });
			await failurePending;
			const successfulBind = harness.session.bindExtensions({ mode: "print" });
			await successPending;
			releaseFailure?.();
			await expect(failedBind).rejects.toThrow("late failure");

			expect(errors).toEqual(["send_user_message"]);
			releaseSuccess?.();
			await successfulBind;
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("keeps a late fatal bind latched until a later bind succeeds", async () => {
			let emission = 0;
			let releaseFailure: (() => void) | undefined;
			let failureStarted: (() => void) | undefined;
			const failurePending = new Promise<void>((resolve) => {
				failureStarted = resolve;
			});
			let releaseSuccess: (() => void) | undefined;
			let successStarted: (() => void) | undefined;
			const successPending = new Promise<void>((resolve) => {
				successStarted = resolve;
			});
			const harness = await harnessWith({
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							emission++;
							if (emission === 2) {
								failureStarted?.();
								await new Promise<void>((resolve) => {
									releaseFailure = resolve;
								});
								throw new ExtensionStartupError("late failure");
							}
							if (emission === 3) {
								successStarted?.();
								await new Promise<void>((resolve) => {
									releaseSuccess = resolve;
								});
							}
						});
					},
				],
			});
			await harness.session.bindExtensions({ mode: "print" });

			const failedBind = harness.session.bindExtensions({ mode: "print" });
			await failurePending;
			const successfulBind = harness.session.bindExtensions({ mode: "print" });
			await successPending;
			releaseSuccess?.();
			await successfulBind;
			releaseFailure?.();
			await expect(failedBind).rejects.toBeInstanceOf(ExtensionStartupError);

			await expect(harness.session.prompt("still latched")).rejects.toThrow("late failure");
			harness.setResponses([fauxAssistantMessage("recovered")]);
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.prompt("recovered");
			expect(harness.faux.state.callCount).toBe(1);
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
