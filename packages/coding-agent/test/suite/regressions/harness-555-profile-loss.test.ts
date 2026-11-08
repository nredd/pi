import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory, SessionStartEvent } from "../../../src/index.ts";
import { createInteractiveHarness } from "../../../src/testing/interactive.ts";
import { createHarness, getMessageText, getToolResult } from "../harness.ts";

const TOOL_NAMES = ["ssh_exec", "monitor_start"];
// An MCP tool: its server may still be connecting when a session resumes.
const MCP_TOOL = "mcp__late__search";

let cwd: string;
let sourceFile: string;

function registerFixtureTools(pi: ExtensionAPI, exposure?: "deferred"): void {
	for (const name of [...TOOL_NAMES, MCP_TOOL])
		pi.registerTool({
			name,
			label: name,
			description: name,
			...(exposure ? { exposure } : {}),
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
		});
}

const directTools: ExtensionFactory = (pi) => registerFixtureTools(pi);
const deferredTools: ExtensionFactory = (pi) => registerFixtureTools(pi, "deferred");

function countNotices(session: AgentSession): number {
	return session.messages.filter(
		(message) => message.role === "custom" && message.customType === "unregistered-tools-notice",
	).length;
}

/** Resume `sourceFile` with `factories` and run one prompt. createHarness does not seed the transcript. */
async function resumeAndPrompt(factories: ExtensionFactory[], prompt: string, sessionStartEvent?: SessionStartEvent) {
	const harness = await createHarness({
		cwd,
		...(sessionStartEvent ? { sessionStartEvent } : {}),
		sessionManager: SessionManager.open(sourceFile),
		extensionFactories: factories,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await harness.session.bindExtensions({ mode: "print" });
	harness.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
	await harness.session.prompt(prompt);
	return harness;
}

// A private persisted session whose transcript declares TOOL_NAMES.
beforeEach(async () => {
	cwd = mkdtempSync(join(tmpdir(), "pi-555-"));
	const first = await createHarness({
		cwd,
		sessionManager: SessionManager.create(cwd, cwd),
		extensionFactories: [directTools],
	});
	try {
		await first.session.bindExtensions({ mode: "print" });
		first.setResponses([fauxAssistantMessage("initial")]);
		await first.session.prompt("first");
		expect(JSON.stringify(first.session.messages)).toContain("ssh_exec");
		const file = first.sessionManager.getSessionFile();
		if (!file) throw new Error("fixture session was not persisted");
		sourceFile = join(cwd, "source.jsonl");
		copyFileSync(file, sourceFile);
	} finally {
		first.cleanup();
	}
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

// nredd/pi-harness#555: resume a private persisted session without the old extension.
test("resuming with missing tools warns the user and model once", async () => {
	const host = await createInteractiveHarness({
		cwd,
		sessionManager: SessionManager.open(sourceFile),
		columns: 160,
		rows: 50,
	});
	try {
		host.harness.session.agent.state.messages = host.harness.sessionManager.buildSessionContext().messages;
		const requests: TranscriptContext[] = [];
		host.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("ssh_exec", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await host.harness.session.prompt("second");
		await host.settle();
		const removals = requests[0]?.messages.flatMap((message) =>
			message.role === "system" ? (message.toolsRemoved ?? []).map((tool) => tool.name) : [],
		);
		expect(removals).toEqual(expect.arrayContaining(TOOL_NAMES));
		expect(host.viewport().join("\n")).toContain("no longer available");
		expect(getMessageText(getToolResult(host.harness, "ssh_exec"))).toBe("Tool ssh_exec not found");
		expect(JSON.stringify(requests[0])).toContain("no longer available");
		host.harness.setResponses([fauxAssistantMessage("again")]);
		await host.harness.session.prompt("third");
		expect(countNotices(host.harness.session)).toBe(1);
	} finally {
		await host.dispose();
	}
});

test("resuming with the same tools does not warn", async () => {
	const harness = await resumeAndPrompt([directTools], "same tools");
	try {
		expect(countNotices(harness.session)).toBe(0);
	} finally {
		harness.cleanup();
	}
});

test("registered deferred tools are not reported as missing", async () => {
	const harness = await resumeAndPrompt([deferredTools], "deferred tools");
	try {
		expect(countNotices(harness.session)).toBe(0);
	} finally {
		harness.cleanup();
	}
});

test("MCP tools that register after the session resumes are not reported as missing", async () => {
	let connect: (() => void) | undefined;
	const lateMcp: ExtensionFactory = (pi) => {
		// Like an MCP server that is still connecting when the session resumes.
		pi.on("session_start", () => {
			connect = () => registerFixtureTools(pi);
		});
	};
	const harness = await resumeAndPrompt([lateMcp], "before the server connects");
	try {
		expect(connect).toBeDefined();
		const notices = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "unregistered-tools-notice",
		);
		// The non-MCP tools are still reported, the MCP one is not.
		expect(JSON.stringify(notices)).toContain("ssh_exec");
		expect(JSON.stringify(notices)).not.toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("a forked session warns about tools it cannot register", async () => {
	// The runtime starts a forked session with this event, see AgentSessionRuntime.fork().
	const harness = await resumeAndPrompt([], "after fork", {
		type: "session_start",
		reason: "fork",
		previousSessionFile: sourceFile,
	});
	try {
		expect(countNotices(harness.session)).toBe(1);
	} finally {
		harness.cleanup();
	}
});
