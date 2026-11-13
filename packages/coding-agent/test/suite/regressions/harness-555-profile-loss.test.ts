import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ImageContent, type TranscriptContext } from "@earendil-works/pi-ai";
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
	for (const name of [...TOOL_NAMES, MCP_TOOL]) {
		pi.registerTool({
			name,
			label: name,
			description: name,
			...(exposure ? { exposure } : {}),
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
		});
	}
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
		expect(getMessageText(getToolResult(host.harness, "ssh_exec"))).toBe(
			"Tool ssh_exec is not available in this request: it is not active (deferred tools must be loaded first), not registered, or excluded by the active profile",
		);
		expect(JSON.stringify(requests[0])).toContain("no longer available");
		host.harness.setResponses([fauxAssistantMessage("again")]);
		await host.harness.session.prompt("third");
		// The second turn reports MCP_TOOL, but TOOL_NAMES were already reported on the first.
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
		const mcpNotices = () => noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL));
		expect(mcpNotices()).toEqual([]);
		await prompt(harness, "second");
		await prompt(harness, "third");
		await prompt(harness, "fourth");
		expect(mcpNotices()).toHaveLength(1);
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

test("a session_start setActiveTools() call does not defeat the MCP grace turn", async () => {
	const startLoadout: ExtensionFactory = (pi) => {
		pi.on("session_start", () => pi.setActiveTools(["read"]));
	};
	const harness = await resumeAndPrompt([startLoadout], "session_start sets the loadout");
	try {
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("explicit --tools resume still gives a late MCP tool its grace turn", async () => {
	let connect: (() => void) | undefined;
	const lateMcp: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			connect = () => registerFixtureTools(pi);
		});
	};
	const harness = await resumeAndPrompt([lateMcp], "before the server connects", {
		initialActiveToolNames: ["read", "bash"],
		allowedToolNames: ["read", "bash"],
	});
	try {
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		connect?.();
		await prompt(harness, "after the server connects");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("a --tools pattern matching the MCP tool gives it the same grace turn", async () => {
	let connect: (() => void) | undefined;
	const lateMcp: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			connect = () => registerFixtureTools(pi);
		});
	};
	const harness = await resumeAndPrompt([lateMcp], "before the server connects", {
		initialActiveToolNames: ["read", "mcp__late__*"],
		allowedToolNames: ["read", "mcp__late__*"],
	});
	try {
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		connect?.();
		await prompt(harness, "after the server connects");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

test("a --tools allowlist unregisters a non-MCP tool, so it is reported", async () => {
	const harness = await resumeAndPrompt([directTools], "allowlisted", {
		initialActiveToolNames: ["read", "monitor_start"],
		allowedToolNames: ["read", "monitor_start"],
	});
	try {
		expect(noticeTexts(harness.session)).toHaveLength(1);
		expect(noticeTexts(harness.session)[0]).toContain("ssh_exec");
	} finally {
		harness.cleanup();
	}
});

test("navigating the tree reports declared non-MCP tools that are not registered", async () => {
	const harness = await resume([]);
	try {
		const earlier = harness.sessionManager.getEntries()[0];
		if (!earlier) throw new Error("no entries");
		await harness.session.navigateTree(earlier.id);
		await prompt(harness, "after navigation");
		expect(noticeTexts(harness.session).join("")).toContain("ssh_exec");
	} finally {
		harness.cleanup();
	}
});

test("navigating the tree gives an unregistered MCP tool of the target branch a grace turn", async () => {
	const harness = await resumeAndPrompt([], "first resumed prompt");
	try {
		const earlier = harness.sessionManager.getEntries()[0];
		if (!earlier) throw new Error("no entries");
		await harness.session.navigateTree(earlier.id);
		await prompt(harness, "after navigation");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

// nredd/pi-harness#555
test("reload gives an MCP tool that was unregistered before it a fresh grace turn", async () => {
	const factories: ExtensionFactory[] = [];
	// The MCP tool is not active, so only the declaration keeps it in the report.
	const harness = await resumeAndPrompt(factories, "before reload", {
		extensionFactories: factories,
		initialActiveToolNames: ["read"],
		allowedToolNames: ["read"],
	});
	try {
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain(MCP_TOOL);
		await harness.session.reload();
		await prompt(harness, "after reload");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		await prompt(harness, "second after reload");
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
		await prompt(harness, "third after reload");
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});

// nredd/pi-harness#634: reload can replace the runtime while before_agent_start is parked.
test.each(["print", "rpc"] as const)(
	"reload during %s run preparation preserves the new MCP grace run",
	async (mode) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const parked: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				entered.resolve();
				await release.promise;
			});
		};
		const harness = await resume([parked]);
		let running: Promise<void> | undefined;
		try {
			await harness.session.bindExtensions({ mode });
			running = prompt(harness, "parked before reload");
			await entered.promise;
			await harness.session.reload();
			release.resolve();
			await running;
			expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
			await prompt(harness, "first after reload");
			expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
			await prompt(harness, "second after reload");
			expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
			await prompt(harness, "third after reload");
			expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
		} finally {
			release.resolve();
			await running;
			harness.cleanup();
		}
	},
);

// nredd/pi-harness#634: the old run must not drop the reload's pending active loadout.
test("reload during preparation keeps late deferred tools pending for activation", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let connect: (() => void) | undefined;
	const parked: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", async () => {
			entered.resolve();
			await release.promise;
		});
	};
	const reconnecting: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			connect = () => registerFixtureTools(pi, "deferred");
		});
	};
	const factories = [directTools, parked];
	const harness = await resume(factories);
	let running: Promise<void> | undefined;
	try {
		running = prompt(harness, "parked with active tools");
		await entered.promise;
		factories.splice(0, factories.length, reconnecting);
		await harness.session.reload();
		release.resolve();
		await running;
		expect(harness.session.getActiveToolNames()).not.toContain(MCP_TOOL);
		if (!connect) throw new Error("reloaded session did not start");
		connect();
		expect(harness.session.getActiveToolNames()).toContain(MCP_TOOL);
		await prompt(harness, "after reconnect");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
	} finally {
		release.resolve();
		await running;
		harness.cleanup();
	}
});

// nredd/pi-harness#555
test("navigating to a branch that declares a held-back MCP tool keeps it held, then reports it once", async () => {
	const harness = await resumeAndPrompt([], "first resumed prompt");
	try {
		const earlier = harness.sessionManager.getEntries()[0];
		if (!earlier) throw new Error("no entries");
		await harness.session.navigateTree(earlier.id);
		await prompt(harness, "after navigation");
		await prompt(harness, "second after navigation");
		await prompt(harness, "third after navigation");
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});

// nredd/pi-harness#555
test("navigating to a branch that does not declare a held-back MCP tool drops it", async () => {
	const harness = await resumeAndPrompt([], "first resumed prompt");
	try {
		// A second root branch whose transcript declares no tools.
		harness.sessionManager.resetLeaf();
		const otherRoot = harness.sessionManager.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("other reply"));
		await harness.session.navigateTree(otherRoot);
		await prompt(harness, "empty branch");
		await prompt(harness, "again");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
	} finally {
		harness.cleanup();
	}
});

// nredd/pi-harness#555
test("a run that fails while starting keeps the MCP grace turn", async () => {
	const harness = await resume([]);
	try {
		// Handler errors do not propagate, so fail image normalization (after before_agent_start).
		const broken = { type: "image", data: undefined, mimeType: "image/png" } as unknown as ImageContent;
		await expect(harness.session.prompt("fails", { images: [broken] })).rejects.toThrow();
		await prompt(harness, "retry");
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		// The report is now due; a failed start must not swallow it.
		await expect(harness.session.prompt("fails again", { images: [broken] })).rejects.toThrow();
		expect(noticeTexts(harness.session).join("")).not.toContain(MCP_TOOL);
		await prompt(harness, "last");
		expect(noticeTexts(harness.session).filter((text) => text.includes(MCP_TOOL))).toHaveLength(1);
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
		if (!entryId) throw new Error("no user message to fork from");
		expect(await runtime.fork(entryId)).toEqual({ cancelled: false, selectedText: "second" });
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
