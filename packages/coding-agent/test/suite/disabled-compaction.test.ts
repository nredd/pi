import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Return a synthetic continuation result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

// Regression #33: default reserve exceeds the physical window, but auto-compaction is disabled.
it.each([false, true])("dispatches small-window provider requests with routed=%s", async (routed) => {
	const h = await createHarness({
		models: [{ id: "small", contextWindow: 8192 }],
		tools: [echoTool],
		useModelRuntimeStream: true,
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "small",
					name: "Small fixture route",
					route(_request, ctx) {
						return { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" };
					},
				});
			},
		],
	});
	harnesses.push(h);
	if (routed) await h.session.setModel(h.session.modelRuntime.getModel("router", "small")!);
	expect(h.settingsManager.getCompactionSettings(h.session.model)).toMatchObject({
		enabled: false,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	});
	const dispatched: string[] = [];
	h.setResponses([
		(_context, _options, _state, model) => {
			dispatched.push(model.id);
			return fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" });
		},
		(_context, _options, _state, model) => {
			dispatched.push(model.id);
			return fauxAssistantMessage("first done");
		},
		(_context, _options, _state, model) => {
			dispatched.push(model.id);
			return fauxAssistantMessage("second done");
		},
	]);
	await h.session.prompt("first prompt");
	expect(h.session.getLastAssistantText()).toBe("first done");
	await h.session.prompt("second prompt");
	expect(h.session.getLastAssistantText()).toBe("second done");
	expect(dispatched).toEqual(["small", "small", "small"]);
	expect(h.getPendingResponseCount()).toBe(0);
	expect(h.eventsOfType("tool_execution_end")).toHaveLength(1);
	expect(h.eventsOfType("compaction_start")).toHaveLength(0);
});
