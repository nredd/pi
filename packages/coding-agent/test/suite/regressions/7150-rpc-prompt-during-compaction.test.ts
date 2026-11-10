import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptDisposition } from "../../../src/core/agent-session.ts";
import type { ExtensionError, ExtensionFactory } from "../../../src/index.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

type SendOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };

/** `session_before_compact` outcome once the gate opens. */
type Outcome = "success" | "fail" | "cancel";

interface ScenarioOptions {
	outcome?: Outcome;
	settings?: { reserveTokens?: number };
	/** Runs inside `session_before_compact`, before the gate. */
	beforeCompact?: (harness: Harness) => Promise<void>;
	/** Runs inside `session_compact`. */
	onCompact?: (harness: Harness) => Promise<void>;
	/** Extra extensions bound alongside the gate extension. */
	extensions?: ExtensionFactory[];
}

interface Scenario {
	harness: Harness;
	/** Resolved when a compaction or tree navigation reaches its gate. */
	started: Deferred;
	/** Open to let the gated compaction or tree navigation continue. */
	release: Deferred;
	/** `session.isStreaming`, sampled when each listener ran. */
	streamingAt: { sessionCompact: boolean[]; sessionCompactFailed: boolean[]; sessionTree: boolean[] };
	/** Prompt summaries (`label`) of each model request, in order. */
	contexts: string[][];
}

const SUMMARY = "SUMMARY_TEXT";
const BRANCH_SUMMARY = "BRANCH_SUMMARY_TEXT";
/** Model-visible prefix of the first run after compaction: summary, kept tail, one-time system patch. */
const COMPACTED = ["summary", "old assistant response", "system"];
const harnesses: Harness[] = [];

/** Harness whose compaction and tree navigation block on `release` until the test opens it. */
async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
	const started = createDeferred();
	const release = createDeferred();
	const streamingAt: Scenario["streamingAt"] = { sessionCompact: [], sessionCompactFailed: [], sessionTree: [] };
	let harnessRef: Harness | undefined;
	const outcome = options.outcome ?? "success";
	const gateExtension: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", async (event) => {
			if (harnessRef) await options.beforeCompact?.(harnessRef);
			started.resolve();
			await release.promise;
			if (outcome === "cancel") return { cancel: true };
			// Hook errors are swallowed by the runner, so "fail" falls through to the default summarizer.
			if (outcome === "fail") return undefined;
			return {
				compaction: {
					summary: SUMMARY,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		pi.on("session_compact", async () => {
			streamingAt.sessionCompact.push(harnessRef?.session.isStreaming ?? false);
			if (harnessRef) await options.onCompact?.(harnessRef);
		});
		pi.on("session_compact_failed", async () => {
			streamingAt.sessionCompactFailed.push(harnessRef?.session.isStreaming ?? false);
		});
		pi.on("session_before_tree", async () => {
			started.resolve();
			await release.promise;
		});
		pi.on("session_tree", async () => {
			streamingAt.sessionTree.push(harnessRef?.session.isStreaming ?? false);
		});
	};
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1, ...options.settings } },
		extensionFactories: [gateExtension, ...(options.extensions ?? [])],
	});
	harnessRef = harness;
	harnesses.push(harness);
	return { harness, started, release, streamingAt, contexts: [] };
}

function appendHistory(harness: Harness, userText: string, assistantText: string, timestamp = Date.now()): void {
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage(assistantText, { timestamp: timestamp + 500 }));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function seedHistory(harness: Harness): void {
	appendHistory(harness, "old user message", "old assistant response", Date.now() - 1000);
}

/** One-line label of a model-visible message; compaction summaries collapse to `summary`. */
function label(message: { role: string }): string {
	if (message.role === "system") return "system";
	const text = getMessageText(message);
	if (text.includes(BRANCH_SUMMARY)) return "branch summary";
	return text.includes(SUMMARY) ? "summary" : text;
}

/** A faux response that records the context of the request it answers. */
function reply(scenario: Scenario, text: string): (context: { messages: { role: string }[] }) => AssistantMessage {
	return (context) => {
		scenario.contexts.push(context.messages.map(label));
		return fauxAssistantMessage(text);
	};
}

/** The active branch in persisted order, one label per entry. */
function persisted(harness: Harness): string[] {
	return harness.sessionManager.getBranch().flatMap((entry) => {
		switch (entry.type) {
			case "message":
				// The one-time empty system patch a first run records is not under test.
				if (entry.message.role === "system" && getMessageText(entry.message) === "") return [];
				return [`${entry.message.role}:${getMessageText(entry.message)}`];
			case "custom_message":
				return [`custom:${entry.customType}`];
			case "compaction":
				return ["compaction"];
			case "branch_summary":
				return ["branch_summary"];
			default:
				return [entry.type];
		}
	});
}

/** A summarizer response that fails the default compaction. */
function summarizerError(): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" });
}

function customEntryCount(harness: Harness): number {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length;
}

function send(harness: Harness, name: string, options?: SendOptions): Promise<void> {
	return harness.session.sendCustomMessage({ customType: name, content: name, display: true, details: {} }, options);
}

/** Capture how an operation settled without leaving a rejection unhandled. */
async function settle(operation: Promise<unknown>): Promise<string> {
	return await operation.then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

/** Start `compact()` and wait until the extension gate holds it. */
async function startCompaction(scenario: Scenario): Promise<{ done: Promise<unknown> }> {
	const done = scenario.harness.session.compact();
	await scenario.started.promise;
	// Boxed: returning the bare promise from an async function would wait for the gated compaction.
	return { done };
}

describe("issue #7150: RPC prompt during manual compaction", () => {
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues a triggered message during manual compaction and delivers it once afterwards", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { deliverAs: "steer", triggerTurn: true });

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.session.isStreaming).toBe(false);
		expect(customEntryCount(harness)).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		// The batch is admitted before `session_compact` listeners run.
		expect(scenario.streamingAt.sessionCompact).toEqual([true]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(scenario.contexts).toEqual([[...COMPACTED, "TRIGGERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:TRIGGERED",
			"assistant:done",
		]);
	});

	it("queues a triggered message during automatic compaction and delivers it once afterwards", async () => {
		// A tiny threshold makes any usage-bearing response cross it; the context window is 128000.
		const scenario = await createScenario({ settings: { reserveTokens: 127_990 } });
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "answer"), reply(scenario, "done")]);

		const prompt = harness.session.prompt("PROMPT");
		await scenario.started.promise;
		// The run that triggered compaction would otherwise re-compact after the delivered turn.
		harness.session.setAutoCompactionEnabled(false);
		await send(harness, "TRIGGERED", { triggerTurn: true });

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(scenario.contexts).toHaveLength(1);
		expect(customEntryCount(harness)).toBe(0);

		scenario.release.resolve();
		await prompt;
		await harness.session.waitForIdle();

		expect(scenario.streamingAt.sessionCompact).toEqual([true]);
		expect(scenario.contexts).toEqual([
			["old user message", "old assistant response", "system", "PROMPT"],
			// The turn that crossed the threshold keeps its answer; the system patch is replayed first.
			["system", "summary", "answer", "TRIGGERED"],
		]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"user:PROMPT",
			"assistant:answer",
			"compaction",
			"custom:TRIGGERED",
			"assistant:done",
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("queues a triggered message during branch summarization and delivers it once afterwards", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		const timestamp = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user" }],
			timestamp: timestamp - 4000,
		});
		const targetId = harness.sessionManager.appendMessage(
			fauxAssistantMessage("first assistant", { timestamp: timestamp - 3000 }),
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "abandoned user" }],
			timestamp: timestamp - 2000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("abandoned assistant", { timestamp: timestamp - 1000 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([reply(scenario, BRANCH_SUMMARY), reply(scenario, "done")]);

		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await scenario.started.promise;
		await send(harness, "TRIGGERED", { triggerTurn: true });

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(scenario.contexts).toHaveLength(0);
		expect(customEntryCount(harness)).toBe(0);

		scenario.release.resolve();
		const result = await navigation;
		await harness.session.waitForIdle();

		expect(result.cancelled).toBe(false);
		expect(scenario.streamingAt.sessionTree).toEqual([true]);
		// Request 0 is the summarizer, request 1 the delivered run.
		expect(scenario.contexts).toHaveLength(2);
		expect(scenario.contexts[1]).toEqual(["first user", "first assistant", "branch summary", "system", "TRIGGERED"]);
		expect(persisted(harness)).toEqual([
			"user:first user",
			"assistant:first assistant",
			"branch_summary",
			"custom:TRIGGERED",
			"assistant:done",
		]);
	});

	it("persists a passive message before the triggered message that starts the run", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "PASSIVE", { triggerTurn: false });
		await send(harness, "TRIGGERED", { triggerTurn: true, deliverAs: "steer" });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "PASSIVE", "TRIGGERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:PASSIVE",
			"custom:TRIGGERED",
			"assistant:done",
		]);
	});

	it("starts the run with a triggered message and persists a later passive message after the turn", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true, deliverAs: "steer" });
		await send(harness, "PASSIVE", { triggerTurn: false });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		// As if sent at the admission instant: a passive message during a live run waits for its turn to end.
		expect(scenario.contexts).toEqual([[...COMPACTED, "TRIGGERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:TRIGGERED",
			"assistant:done",
			"custom:PASSIVE",
		]);
	});

	it("steers a later deliverAs steer message into the delivered run", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "first")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true });
		await send(harness, "STEERED", { deliverAs: "steer" });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		// The steering queue is polled before the run's first request, as for any send during run startup.
		expect(scenario.contexts).toEqual([[...COMPACTED, "TRIGGERED", "STEERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:TRIGGERED",
			"custom:STEERED",
			"assistant:first",
		]);
	});

	it("queues a later deliverAs followUp message on the delivered run", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "first"), reply(scenario, "second")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true });
		await send(harness, "FOLLOWED_UP", { deliverAs: "followUp" });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(scenario.contexts).toEqual([
			[...COMPACTED, "TRIGGERED"],
			[...COMPACTED, "TRIGGERED", "first", "FOLLOWED_UP"],
		]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:TRIGGERED",
			"assistant:first",
			"custom:FOLLOWED_UP",
			"assistant:second",
		]);
	});

	it("starts a run for a triggered followUp message that is the only run-starting item", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "FOLLOWED_UP", { deliverAs: "followUp", triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "FOLLOWED_UP"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:FOLLOWED_UP",
			"assistant:done",
		]);
	});

	it("holds a deliverAs nextTurn message for the next user prompt without triggering", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "NEXT", { deliverAs: "nextTurn", triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(persisted(harness)).toEqual(["user:old user message", "assistant:old assistant response", "compaction"]);

		await harness.session.prompt("PROMPT");
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "PROMPT", "NEXT"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"user:PROMPT",
			"custom:NEXT",
			"assistant:done",
		]);
	});

	it("delivers a nextTurn message with a custom-triggered run outside compaction", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		harness.setResponses([reply(scenario, "done")]);

		await send(harness, "X", { deliverAs: "nextTurn" });
		await send(harness, "CUSTOM", { triggerTurn: true });
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([["system", "CUSTOM", "X"]]);
		expect(persisted(harness)).toEqual(["custom:CUSTOM", "custom:X", "assistant:done"]);
	});

	it("preserves nextTurn enqueue order across compaction and session_compact listeners", async () => {
		const scenario = await createScenario({
			onCompact: async (harness) => {
				await send(harness, "B", { deliverAs: "nextTurn", triggerTurn: true });
			},
		});
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "A", { deliverAs: "nextTurn", triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await harness.session.prompt("PROMPT");
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "PROMPT", "A", "B"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"user:PROMPT",
			"custom:A",
			"custom:B",
			"assistant:done",
		]);
	});

	it("holds listener nextTurn messages behind a compaction-deferred message until a user prompt", async () => {
		const scenario = await createScenario({
			onCompact: async (harness) => {
				await send(harness, "B", { deliverAs: "nextTurn", triggerTurn: true });
			},
		});
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "custom response"), reply(scenario, "user response")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "A", { deliverAs: "nextTurn", triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await send(harness, "CUSTOM", { triggerTurn: true });
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "CUSTOM"]]);

		await harness.session.prompt("PROMPT");
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([
			[...COMPACTED, "CUSTOM"],
			[...COMPACTED, "CUSTOM", "custom response", "PROMPT", "A", "B"],
		]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:CUSTOM",
			"assistant:custom response",
			"user:PROMPT",
			"custom:A",
			"custom:B",
			"assistant:user response",
		]);
	});

	it("holds plain nextTurn messages queued after a compaction-deferred message", async () => {
		const scenario = await createScenario({
			onCompact: async (harness) => {
				await send(harness, "Y", { deliverAs: "nextTurn" });
			},
		});
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "custom response"), reply(scenario, "user response")]);

		await send(harness, "X", { deliverAs: "nextTurn" });
		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "A", { deliverAs: "nextTurn", triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await send(harness, "CUSTOM", { triggerTurn: true });
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "CUSTOM", "X"]]);

		await harness.session.prompt("PROMPT");
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([
			[...COMPACTED, "CUSTOM", "X"],
			[...COMPACTED, "CUSTOM", "X", "custom response", "PROMPT", "A", "Y"],
		]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:CUSTOM",
			"custom:X",
			"assistant:custom response",
			"user:PROMPT",
			"custom:A",
			"custom:Y",
			"assistant:user response",
		]);
	});

	it("lands sends and prompts from a compaction_end listener after the delivered batch", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "one"), reply(scenario, "two")]);
		const listenerOperations: Promise<void>[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			listenerOperations.push(send(harness, "LISTENER_SEND", { triggerTurn: true }));
			listenerOperations.push(harness.session.prompt("LISTENER_PROMPT", { streamingBehavior: "followUp" }));
		});

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "BATCH", { triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await Promise.all(listenerOperations);
		await harness.session.waitForIdle();

		expect(listenerOperations).toHaveLength(2);
		expect(scenario.contexts).toEqual([
			[...COMPACTED, "BATCH", "LISTENER_SEND"],
			[...COMPACTED, "BATCH", "LISTENER_SEND", "one", "LISTENER_PROMPT"],
		]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:BATCH",
			"custom:LISTENER_SEND",
			"assistant:one",
			"user:LISTENER_PROMPT",
			"assistant:two",
		]);
	});

	it("rejects an overlapping manual compaction while compaction runs", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);

		const { done: first } = await startCompaction(scenario);
		await expect(harness.session.compact()).rejects.toThrow("Compaction is already in progress.");
		scenario.release.resolve();
		await first;

		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("rejects an overlapping manual compaction while session_compact_failed listeners run", async () => {
		let overlap: Promise<string> | undefined;
		let sessionHarness: Harness | undefined;
		const failedHandlerRan = createDeferred();
		const scenario = await createScenario({
			outcome: "fail",
			extensions: [
				(pi) => {
					pi.on("session_compact_failed", async () => {
						if (!sessionHarness) return;
						overlap = settle(sessionHarness.session.compact());
						await overlap;
						failedHandlerRan.resolve();
					});
				},
			],
		});
		sessionHarness = scenario.harness;
		seedHistory(scenario.harness);
		scenario.harness.setResponses([summarizerError()]);

		const { done: compaction } = await startCompaction(scenario);
		scenario.release.resolve();
		const compactionOutcome = await settle(compaction);
		await failedHandlerRan.promise;

		expect(compactionOutcome).toContain("summary failed");
		expect(await overlap).toBe("Compaction is already in progress.");
		expect(scenario.harness.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("drops a queued triggered message when the session is disposed before admission", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true });
		harness.session.dispose();
		scenario.release.resolve();
		const outcome = await settle(compaction);

		expect(outcome).toBe("Compaction cancelled");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(scenario.contexts).toEqual([]);
		expect(persisted(harness)).toEqual(["user:old user message", "assistant:old assistant response"]);
	});

	it("stops admitting a queued batch when the session is disposed mid-admission", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "FIRST") {
				harness.session.dispose();
			}
		});

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "FIRST", { triggerTurn: false });
		await send(harness, "SECOND", { triggerTurn: false });
		await send(harness, "THIRD", { triggerTurn: false });
		scenario.release.resolve();
		await settle(compaction);

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(
			harness.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : [])),
		).toEqual(["FIRST"]);
	});

	it("resolves a send awaited inside session_before_compact", async () => {
		const hookSendSettled = createDeferred();
		const scenario = await createScenario({
			beforeCompact: async (harness) => {
				await send(harness, "FROM_HOOK", { triggerTurn: true });
				hookSendSettled.resolve();
			},
		});
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);
		scenario.release.resolve();

		await harness.session.compact();
		await hookSendSettled.promise;
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "FROM_HOOK"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:FROM_HOOK",
			"assistant:done",
		]);
	});

	it("resolves a send awaited inside session_compact and lands it after the batch", async () => {
		const hookSendSettled = createDeferred();
		const scenario = await createScenario({
			onCompact: async (harness) => {
				await send(harness, "FROM_HOOK", { triggerTurn: true });
				hookSendSettled.resolve();
			},
		});
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "one")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "BATCH", { triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await hookSendSettled.promise;
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([[...COMPACTED, "BATCH", "FROM_HOOK"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"compaction",
			"custom:BATCH",
			"custom:FROM_HOOK",
			"assistant:one",
		]);
	});

	it("reports a passive admission listener failure and releases the compaction owner", async () => {
		const errors: ExtensionError[] = [];
		let throwOnPassiveMessage = true;
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		await harness.session.bindExtensions({
			onError: (error) => {
				errors.push(error);
			},
		});
		harness.session.subscribe((event) => {
			if (throwOnPassiveMessage && event.type === "message_end" && event.message.role === "custom") {
				throw new Error("passive admission listener failed");
			}
		});

		const { done: first } = await startCompaction(scenario);
		await send(harness, "PASSIVE", { triggerTurn: false });
		scenario.release.resolve();
		await settle(first);
		throwOnPassiveMessage = false;
		appendHistory(harness, "later user message", "later assistant response");
		await harness.session.compact();

		expect(errors).toContainEqual({
			extensionPath: "<runtime>",
			event: "send_message",
			error: "passive admission listener failed",
		});
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
	});

	it("reports a deferred admission failure as send_message", async () => {
		const startGate = createDeferred();
		const reported = createDeferred();
		const errors: ExtensionError[] = [];
		const scenario = await createScenario({
			extensions: [
				(pi) => {
					pi.on("session_start", async () => {
						await startGate.promise;
					});
				},
			],
		});
		const { harness } = scenario;
		seedHistory(harness);

		const { done: compaction } = await startCompaction(scenario);
		// A session_start still in flight makes the run refuse to start once admission fires.
		const bound = harness.session.bindExtensions({
			onError: (error) => {
				errors.push(error);
				reported.resolve();
			},
		});
		await send(harness, "TRIGGERED", { triggerTurn: true });
		scenario.release.resolve();
		await compaction;
		await reported.promise;
		startGate.resolve();
		await bound;
		await harness.session.waitForIdle();

		expect(errors).toEqual([
			{
				extensionPath: "<runtime>",
				event: "send_message",
				error: "Session extensions are still starting. Await bindExtensions() or reload() before sending requests.",
			},
		]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("delivers the queued batch exactly once when compaction fails", async () => {
		const scenario = await createScenario({ outcome: "fail" });
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([summarizerError(), reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true });
		scenario.release.resolve();
		const outcome = await settle(compaction);
		await harness.session.waitForIdle();

		expect(outcome).toContain("summary failed");
		expect(scenario.streamingAt.sessionCompactFailed).toEqual([true]);
		expect(scenario.contexts).toEqual([["old user message", "old assistant response", "system", "TRIGGERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"custom:TRIGGERED",
			"assistant:done",
		]);
	});

	it("delivers the queued batch exactly once when compaction is aborted", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "done")]);

		const { done: compaction } = await startCompaction(scenario);
		await send(harness, "TRIGGERED", { triggerTurn: true });
		harness.session.abortCompaction();
		scenario.release.resolve();
		const outcome = await settle(compaction);
		await harness.session.waitForIdle();

		expect(outcome).toBe("Compaction cancelled");
		expect(scenario.streamingAt.sessionCompactFailed).toEqual([true]);
		expect(scenario.contexts).toEqual([["old user message", "old assistant response", "system", "TRIGGERED"]]);
		expect(persisted(harness)).toEqual([
			"user:old user message",
			"assistant:old assistant response",
			"custom:TRIGGERED",
			"assistant:done",
		]);
	});

	it("accepts a user prompt while automatic compaction is in progress", async () => {
		const scenario = await createScenario({ settings: { reserveTokens: 127_990 } });
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "first response"), reply(scenario, "second response")]);

		const firstPrompt = harness.session.prompt("FIRST");
		await scenario.started.promise;
		// Keep the second prompt from crossing the threshold and starting another compaction.
		harness.session.setAutoCompactionEnabled(false);
		const secondPrompt = harness.session.prompt("SECOND", { streamingBehavior: "followUp" });
		scenario.release.resolve();
		await firstPrompt;
		await secondPrompt;
		await harness.session.waitForIdle();

		expect(scenario.contexts).toEqual([
			["old user message", "old assistant response", "system", "FIRST"],
			["system", "summary", "first response", "SECOND"],
		]);
		expect(getUserTexts(harness)).toContain("SECOND");
	});

	it("rejects an RPC prompt while manual compaction is in progress", async () => {
		const scenario = await createScenario();
		const { harness } = scenario;
		seedHistory(harness);
		harness.setResponses([reply(scenario, "probe response")]);

		const { done: compaction } = await startCompaction(scenario);
		let preflightResult: PromptDisposition | undefined;
		const promptOutcome = await settle(
			harness.session.prompt("PROBE-7150", {
				source: "rpc",
				preflightResult: (result) => {
					preflightResult = result;
				},
			}),
		);
		scenario.release.resolve();
		await compaction;

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResult).toBeUndefined();
		expect(promptOutcome).toContain("compaction is in progress");
		expect(getUserTexts(harness)).not.toContain("PROBE-7150");
		expect(persistedUserTexts).not.toContain("PROBE-7150");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
	});
});
