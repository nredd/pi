import { fauxAssistantMessage, fauxToolCall, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression nredd/pi-harness#435: a resumed or continued child failed before any new tool work
 * with Anthropic 400 `tool_reference_unresolved` ("tool_addition/tool_removal references unknown
 * tool 'web_enable'"). The installed extensions combine two legitimate behaviors:
 *
 * - a deferred-tool engine promotes a loader tool, and the loader is inactive again by the time the
 *   child continues, so the next request declares the loader's removal (pi-subagents resumes by
 *   prompting the same session);
 * - its `context_with_system` projection hides inactive tools from earlier `toolsAdded` but leaves
 *   later `toolsRemoved` alone (pi-deferred-context-engine 0.5.0 `prioritizeContext`).
 *
 * The request then removes a tool it never declared.
 */
const LOADER = "web_enable";

function deferredLoaderExtension(pi: ExtensionAPI): void {
	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
	pi.registerTool({
		name: "search_tools",
		label: "search_tools",
		description: "Promote deferred tools.",
		parameters: Type.Object({}),
		execute: async () => {
			pi.setActiveTools([...pi.getActiveTools(), LOADER]);
			return text(`promoted ${LOADER}`);
		},
	});
	pi.registerTool({
		name: "demote_tools",
		label: "demote_tools",
		description: "Demote deferred tools.",
		parameters: Type.Object({}),
		execute: async () => {
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== LOADER));
			return text(`demoted ${LOADER}`);
		},
	});
	pi.registerTool({
		name: LOADER,
		label: LOADER,
		description: "Enable web tools.",
		parameters: Type.Object({}),
		execute: async () => text("enabled"),
	});
	pi.on("context_with_system", (event) => {
		const active = new Set(pi.getActiveTools());
		return {
			messages: event.messages.map((message) => {
				if (message.role !== "system" || !message.toolsAdded) return message;
				return { ...message, toolsAdded: message.toolsAdded.filter((tool) => active.has(tool.name)) };
			}),
		};
	});
}

const anthropicNative: Model<"anthropic-messages"> = {
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

interface WireBlock {
	type: string;
	tool?: { name?: string; definition?: { name: string } };
}

interface WirePayload {
	tools?: Array<{ name: string }>;
	messages: Array<{ role: string; content: string | WireBlock[] }>;
}

class PayloadCaptured extends Error {}

/** Convert the request the session sent into the Anthropic payload that would go on the wire. */
async function toAnthropicPayload(context: TranscriptContext): Promise<WirePayload> {
	let captured: WirePayload | undefined;
	await streamSimple(anthropicNative, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as WirePayload;
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("expected an Anthropic payload");
	return captured;
}

/** Tool references Anthropic resolves against the request's own declarations, in order. */
function unresolvedToolReferences(payload: WirePayload): string[] {
	const declared = new Set(payload.tools?.map((tool) => tool.name));
	const unresolved: string[] = [];
	for (const message of payload.messages) {
		if (message.role !== "system" || typeof message.content === "string") continue;
		for (const block of message.content) {
			if (block.type === "tool_addition" && block.tool?.definition) declared.add(block.tool.definition.name);
			if (block.type === "tool_removal" && block.tool?.name && !declared.delete(block.tool.name)) {
				unresolved.push(block.tool.name);
			}
		}
	}
	return unresolved;
}

function removedTools(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) =>
		message.role === "system" ? (message.toolsRemoved ?? []).map((tool) => tool.name) : [],
	);
}

describe("harness#435 orphan tool removals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resumes a completed child after its promoted loader went inactive", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "search_tools"],
			extensionFactories: [deferredLoaderExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("search_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find a web tool");
		expect(harness.session.getActiveToolNames()).toContain(LOADER);

		harness.session.setActiveToolsByName(harness.session.getActiveToolNames().filter((name) => name !== LOADER));
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context: TranscriptContext) => {
				request = context;
				return fauxAssistantMessage("resumed");
			},
		]);
		await harness.session.prompt("read it again");

		if (!request) throw new Error("expected the resumed request");
		expect(removedTools(request)).toEqual([LOADER]);
		expect(unresolvedToolReferences(await toAnthropicPayload(request))).toEqual([]);
	});

	it("continues a run after the loader is demoted mid-run", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "search_tools", "demote_tools"],
			extensionFactories: [deferredLoaderExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let request: TranscriptContext | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("search_tools", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("demote_tools", {})], { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				request = context;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("promote, then demote");

		if (!request) throw new Error("expected the continuation request");
		expect(removedTools(request)).toEqual([LOADER]);
		expect(unresolvedToolReferences(await toAnthropicPayload(request))).toEqual([]);
	});
});
