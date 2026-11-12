import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness, type InteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";
import { getKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TranscriptEntryIdentities } from "../src/modes/interactive/transcript-entries.ts";

const action = "app.transcript.previousUserPrompt";
const jump = "\x1b[19~";
const bottom = "\x1b[1;5F";
const output = Array.from({ length: 35 }, (_, i) => `substantial output ${i}`).join("\n");

async function command(host: InteractiveHarness, text: string): Promise<void> {
	host.input(text);
	host.input("\r");
	await host.settle();
}

// nredd/pi#29: real editor, commands, session replay and root-layout navigation.
describe("previous canonical user prompt", () => {
	it("shares slash/shortcut navigation while retaining draft bytes, cursor, focus and history", async () => {
		const host = await createInteractiveHarness({
			columns: 80,
			rows: 18,
			settings: { fullscreenScrollbar: "hidden" },
		});
		try {
			expect(getKeybindings().getKeys(action)).toEqual([]);
			getKeybindings().setUserBindings({ [action]: "f8" });
			host.harness.setResponses([
				fauxAssistantMessage(output),
				fauxAssistantMessage(output),
				fauxAssistantMessage(output),
			]);
			for (const text of ["first prompt", "second prompt", "third prompt"]) {
				await command(host, text);
				await host.harness.session.waitForIdle();
			}
			await host.settle();
			host.input("retained  draft");
			host.input("\x1b[D");
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "third prompt"),
				host.viewport().join("\n"),
			).toBe(true);
			host.input("X");
			await host.settle();
			expect(host.viewport().some((line) => line.includes("retained  drafXt"))).toBe(true);
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "second prompt"),
			).toBe(true);
			// Clear only the draft, then submit the same navigation through the slash dispatcher.
			host.input("\x01");
			host.input("\x0b");
			const before = host.harness.session.messages.length;
			await command(host, "/previous-prompt");
			expect(host.harness.session.messages).toHaveLength(before);
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "first prompt"),
			).toBe(true);
			host.input("\x1b[A");
			await host.settle();
			expect(host.viewport().some((line) => line.includes("third prompt"))).toBe(true); // command is not prompt history
			host.input(bottom);
			await host.settle();
			expect(host.viewport().some((line) => line.includes("substantial output 34"))).toBe(true);
		} finally {
			await host.dispose();
		}
	});

	it("replays duplicate text/different IDs, multipart, skill and attachment entries as single canonical targets", async () => {
		const manager = SessionManager.inMemory("/tmp");
		const texts = [
			"same",
			"same",
			'<skill name="example" location="/tmp/example/SKILL.md">\nSkill body\n</skill>\n\ntrailing words',
		];
		for (const [index, text] of texts.entries()) {
			manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage(`entry ${index}\n${output}`));
		}
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "" }],
			timestamp: 1,
		});
		manager.appendMessage(fauxAssistantMessage(output));
		const host = await createInteractiveHarness({
			columns: 80,
			rows: 18,
			sessionManager: manager,
			settings: { fullscreenScrollbar: "hidden" },
		});
		try {
			getKeybindings().setUserBindings({ [action]: "f8" });
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.includes("Attachment-only user prompt")),
			).toBe(true);
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => /skill/i.test(line)),
			).toBe(true);
			expect(
				host.viewport().some((line) => line.trim() === "trailing words"),
				host.viewport().join("\n"),
			).toBe(true);
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "same"),
			).toBe(true);
			expect(host.viewport().join("\n")).toContain("entry 1");
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "same"),
			).toBe(true);
			expect(host.viewport().join("\n")).toContain("entry 0");
		} finally {
			await host.dispose();
		}
	});

	it("keeps runtime identity when persistence follows delivery and replay uses a new message object", () => {
		const identities = new TranscriptEntryIdentities();
		const manager = SessionManager.inMemory("/tmp");
		const message = { role: "user" as const, content: "same", timestamp: 1 };
		const identity = identities.get(message);
		expect(identity.entryId).toBeUndefined();
		const id = manager.appendMessage(message);
		identities.associate(manager.getEntries());
		expect(identity.entryId).toBe(id);
		expect(identities.get({ ...message }, id)).toBe(identity);
		expect(identities.get({ ...message }, "other-id")).not.toBe(identity);
	});

	it("discovers unbound/effective hotkeys, supports remap/disable, and leaves dialogs in control", async () => {
		const host = await createInteractiveHarness({ columns: 120, rows: 80 });
		try {
			host.input("/previous-p");
			await host.settle();
			expect(host.viewport().some((line) => line.includes("previous-prompt"))).toBe(true);
			host.input("\x1b");
			host.input("\x01");
			host.input("\x0b");
			await command(host, "/hotkeys");
			expect(host.viewport().some((line) => line.includes("Unbound") && line.includes("Previous user prompt"))).toBe(
				true,
			);
			getKeybindings().setUserBindings({ [action]: "f8" });
			await command(host, "/hotkeys");
			expect(host.viewport().some((line) => /F8/.test(line) && line.includes("Previous user prompt"))).toBe(true);
			await command(host, "/settings");
			const before = host.viewport();
			host.input(jump);
			await host.settle();
			expect(host.viewport()).toEqual(before);
			host.input("\x1b");
			getKeybindings().setUserBindings({ [action]: [] });
			expect(getKeybindings().getKeys(action)).toEqual([]);
		} finally {
			await host.dispose();
		}
	});

	it("reloads remapped and disabled keys from isolated configuration", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-prompt-bindings-"));
		const path = join(dir, "keybindings.json");
		writeFileSync(path, JSON.stringify({ [action]: "f8" }));
		const host = await createInteractiveHarness({
			keybindings: KeybindingsManager.create(dir),
			columns: 80,
			rows: 18,
			settings: { fullscreenScrollbar: "hidden" },
		});
		try {
			host.harness.setResponses([fauxAssistantMessage(output)]);
			await host.harness.session.prompt("canonical prompt");
			await host.settle();
			writeFileSync(path, JSON.stringify({ [action]: "f9" }));
			await command(host, "/reload");
			expect(getKeybindings().getKeys(action)).toEqual(["f9"]);
			host.input("\x1b[20~");
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "canonical prompt"),
			).toBe(true);
			writeFileSync(path, JSON.stringify({ [action]: [] }));
			await command(host, "/reload");
			expect(getKeybindings().getKeys(action)).toEqual([]);
		} finally {
			await host.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes extension user messages but excludes custom notices and assistant markers", async () => {
		const host = await createInteractiveHarness({
			columns: 80,
			rows: 18,
			settings: { fullscreenScrollbar: "hidden" },
		});
		try {
			getKeybindings().setUserBindings({ [action]: "f8" });
			host.harness.setResponses([fauxAssistantMessage(output), fauxAssistantMessage(output)]);
			await host.harness.session.prompt("ordinary user");
			await host.harness.session.sendCustomMessage({
				customType: "notice",
				content: "not a user prompt",
				display: true,
			});
			await host.harness.session.sendUserMessage([
				{ type: "text", text: "extension " },
				{ type: "text", text: "user" },
			]);
			await host.settle();
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "extension"),
				host.viewport().join("\n"),
			).toBe(true);
			host.input(jump);
			await host.settle();
			expect(
				host
					.viewport()
					.slice(0, 3)
					.some((line) => line.trim() === "ordinary user"),
			).toBe(true);
			await command(host, "/new");
			await command(host, "/previous-prompt");
			expect(host.viewport().join("\n")).toContain("No previous user prompt.");
		} finally {
			await host.dispose();
		}
	});

	it("reports regular mode without adding a transcript entry or losing the draft", async () => {
		const host = await createInteractiveHarness({ tuiMode: "regular", columns: 100, rows: 18 });
		try {
			getKeybindings().setUserBindings({ [action]: "f8" });
			host.input("draft");
			host.input(jump);
			await host.settle();
			expect(host.viewport().join("\n")).toContain("Requires fullscreen transcript navigation.");
			expect(host.viewport().join("\n")).toContain("draft");
			expect(host.harness.session.messages).toHaveLength(0);
		} finally {
			await host.dispose();
		}
	});
});
