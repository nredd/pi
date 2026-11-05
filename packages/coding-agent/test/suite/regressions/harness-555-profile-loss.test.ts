import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createInteractiveHarness } from "../../../src/testing/interactive.ts";
import { createHarness, getMessageText, getToolResult } from "../harness.ts";

// nredd/pi-harness#555: resume a private persisted session without the old extension.
test("resuming with missing tools warns the user and model", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-555-"));
	const tools: ExtensionFactory = (pi) => {
		for (const name of ["ssh_exec", "monitor_start"])
			pi.registerTool({
				name,
				label: name,
				description: name,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
			});
	};
	try {
		const first = await createHarness({
			cwd,
			sessionManager: SessionManager.create(cwd, cwd),
			extensionFactories: [tools],
		});
		let file: string;
		try {
			await first.session.bindExtensions({ mode: "print" });
			first.setResponses([fauxAssistantMessage("initial")]);
			await first.session.prompt("first");
			expect(JSON.stringify(first.session.messages)).toContain("ssh_exec");
			file = first.sessionManager.getSessionFile()!;
		} finally {
			first.cleanup();
		}
		const deferredFile = join(cwd, "deferred.jsonl");
		copyFileSync(file, deferredFile);
		const deferredTools: ExtensionFactory = (pi) => {
			for (const name of ["ssh_exec", "monitor_start"])
				pi.registerTool({
					name,
					label: name,
					description: name,
					exposure: "deferred",
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				});
		};
		const deferred = await createHarness({
			cwd,
			sessionManager: SessionManager.open(deferredFile),
			extensionFactories: [deferredTools],
		});
		try {
			deferred.session.agent.state.messages = deferred.sessionManager.buildSessionContext().messages;
			await deferred.session.bindExtensions({ mode: "print" });
			deferred.setResponses([fauxAssistantMessage("deferred")]);
			await deferred.session.prompt("deferred tools");
			expect(
				deferred.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "unregistered-tools-notice",
				),
			).toHaveLength(0);
		} finally {
			deferred.cleanup();
		}
		const unchanged = await createHarness({
			cwd,
			sessionManager: SessionManager.open(file),
			extensionFactories: [tools],
		});
		try {
			unchanged.session.agent.state.messages = unchanged.sessionManager.buildSessionContext().messages;
			await unchanged.session.bindExtensions({ mode: "print" });
			unchanged.setResponses([fauxAssistantMessage("unchanged")]);
			await unchanged.session.prompt("same tools");
			expect(
				unchanged.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "unregistered-tools-notice",
				),
			).toHaveLength(0);
		} finally {
			unchanged.cleanup();
		}
		const host = await createInteractiveHarness({
			cwd,
			sessionManager: SessionManager.open(file),
			columns: 160,
			rows: 50,
		});
		try {
			// createHarness does not seed Agent.initialState.messages as the SDK factory does.
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
			expect(removals).toEqual(expect.arrayContaining(["ssh_exec", "monitor_start"]));
			expect(host.viewport().join("\n")).toContain("no longer available");
			expect(getMessageText(getToolResult(host.harness, "ssh_exec"))).toBe("Tool ssh_exec not found");
			expect(JSON.stringify(requests[0])).toContain("no longer available");
			host.harness.setResponses([fauxAssistantMessage("again")]);
			await host.harness.session.prompt("third");
			expect(
				host.harness.session.messages.filter(
					(message) => message.role === "custom" && message.customType === "unregistered-tools-notice",
				),
			).toHaveLength(1);
		} finally {
			await host.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
