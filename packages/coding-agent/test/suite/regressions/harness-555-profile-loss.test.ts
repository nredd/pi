import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import { createInteractiveHarness } from "../../../src/testing/interactive.ts";
import { createTestResourceLoader } from "../../utilities.ts";
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

function noticeTexts(session: AgentSession): string[] {
	return session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === "unregistered-tools-notice"
			? [JSON.stringify(message.content)]
			: [],
	);
}

function countNotices(session: AgentSession): number {
	return noticeTexts(session).length;
}

type HarnessOptions = Parameters<typeof createHarness>[0];

/** Resume `sourceFile` with `factories`. createHarness does not seed the transcript. */
async function resume(factories: ExtensionFactory[], options: HarnessOptions = {}) {
	const harness = await createHarness({
		cwd,
		sessionManager: SessionManager.open(sourceFile),
		extensionFactories: factories,
		...options,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await harness.session.bindExtensions({ mode: "print" });
	return harness;
}

async function prompt(harness: Awaited<ReturnType<typeof resume>>, text: string): Promise<void> {
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt(text);
}

async function resumeAndPrompt(factories: ExtensionFactory[], text: string, options: HarnessOptions = {}) {
	const harness = await resume(factories, options);
	await prompt(harness, text);
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
		// Only the MCP tool's later notice follows, so the TOOL_NAMES are not repeated.
		expect(noticeTexts(host.harness.session).filter((text) => text.includes("ssh_exec"))).toHaveLength(1);
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

test("MCP tools that register after the first prompt are never reported", async () => {
	let connect: (() => void) | undefined;
	const lateMcp: ExtensionFactory = (pi) => {
		// Like an MCP server that is still connecting when the session resumes.
		pi.on("session_start", () => {
			connect = () => registerFixtureTools(pi);
		});
	};
	const harness = await resumeAndPrompt([lateMcp], "before the server connects");
	try {
		// The non-MCP tools are reported on the first turn, the MCP one is not.
		expect(countNotices(harness.session)).toBe(1);
		expect(noticeTexts(harness.session)[0]).toContain("ssh_exec");
		expect(noticeTexts(harness.session)[0]).not.toContain(MCP_TOOL);
		connect?.();
		await prompt(harness, "after the server connects");
		expect(countNotices(harness.session)).toBe(1);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("an MCP tool that never registers is reported once, on the turn after the grace turn", async () => {
	const harness = await resumeAndPrompt([], "first");
	try {
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toEqual([]);
		await prompt(harness, "second");
		await prompt(harness, "third");
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});

test("a before_agent_start setActiveTools() call does not defeat the MCP grace turn", async () => {
	const pendingLoadout: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", () => pi.setActiveTools(["read"]));
	};
	const harness = await resumeAndPrompt([pendingLoadout], "handler sets the loadout");
	try {
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("--exclude-tools unregisters a tool, so it is reported", async () => {
	const harness = await resumeAndPrompt([directTools], "excluded", { excludedToolNames: ["ssh_exec"] });
	try {
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("ssh_exec");
		expect(noticeTexts(harness.session)).toHaveLength(1);
		expect(noticeTexts(harness.session)[0]).toContain("ssh_exec");
		expect(noticeTexts(harness.session)[0]).not.toContain("monitor_start");
	} finally {
		harness.cleanup();
	}
});

test("a reloaded session warns about tools its new extensions no longer register", async () => {
	const factories = [directTools];
	const harness = await resumeAndPrompt(factories, "before reload", { extensionFactories: factories });
	try {
		expect(countNotices(harness.session)).toBe(0);
		factories.splice(0);
		await harness.session.reload();
		await prompt(harness, "after reload");
		expect(countNotices(harness.session)).toBe(1);
		expect(noticeTexts(harness.session)[0]).toContain("ssh_exec");
	} finally {
		harness.cleanup();
	}
});

test("a forked session warns about tools its runtime cannot register", async () => {
	const parent = await resume([directTools]);
	const services: AgentSessionServices = {
		cwd,
		agentDir: parent.tempDir,
		modelRuntime: parent.session.modelRuntime,
		settingsManager: parent.settingsManager,
		resourceLoader: createTestResourceLoader(),
		diagnostics: [],
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: parent.getModel(),
			noTools: "all",
		})),
		services,
		diagnostics: [],
	});
	const runtime = new AgentSessionRuntime(parent.session, services, createRuntime);
	try {
		await prompt(parent, "second");
		expect(parent.session.getAllTools().map((tool) => tool.name)).toContain("ssh_exec");
		const entryId = runtime.session.getUserMessagesForForking()[1]?.entryId;
		expect(entryId).toBeDefined();
		expect(await runtime.fork(entryId!)).toEqual({ cancelled: false, selectedText: "second" });
		expect(runtime.session).not.toBe(parent.session);
		await runtime.session.bindExtensions({});
		expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain("ssh_exec");
		parent.setResponses([fauxAssistantMessage("ok")]);
		await runtime.session.prompt("after fork");
		expect(countNotices(runtime.session)).toBe(1);
		expect(noticeTexts(runtime.session)[0]).toContain("ssh_exec");
	} finally {
		await runtime.dispose();
		parent.cleanup();
	}
});
