import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { isSubagentSession, SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function session(overrides: Partial<SessionInfo>): SessionInfo {
	return {
		path: "/tmp/s.jsonl",
		id: "s",
		cwd: "",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
		...overrides,
	};
}

describe("isSubagentSession", () => {
	it("matches a child named <agent>#<8 hex>", () => {
		expect(isSubagentSession(session({ name: "code-reviewer#da7be78e", parentSessionPath: "/tmp/p.jsonl" }))).toBe(
			true,
		);
		expect(isSubagentSession(session({ name: "general-purpose#376a4f94", parentSessionPath: "/tmp/p.jsonl" }))).toBe(
			true,
		);
	});

	it("keeps user forks, named or not", () => {
		expect(isSubagentSession(session({ parentSessionPath: "/tmp/p.jsonl" }))).toBe(false);
		expect(isSubagentSession(session({ name: "try other approach", parentSessionPath: "/tmp/p.jsonl" }))).toBe(false);
	});

	it("keeps top-level sessions even with a lookalike name", () => {
		expect(isSubagentSession(session({ name: "code-reviewer#da7be78e" }))).toBe(false);
	});

	it("requires exactly 8 hex chars", () => {
		expect(isSubagentSession(session({ name: "agent#da7be78", parentSessionPath: "/tmp/p.jsonl" }))).toBe(false);
		expect(isSubagentSession(session({ name: "agent#da7be78eff", parentSessionPath: "/tmp/p.jsonl" }))).toBe(false);
	});
});

describe("/resume list", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("lists the top-level thread and hides its subagent children", async () => {
		const sessions = [
			session({ id: "top", path: "/tmp/top.jsonl", firstMessage: "top level prompt" }),
			session({
				id: "kid",
				path: "/tmp/kid.jsonl",
				name: "code-reviewer#da7be78e",
				parentSessionPath: "/tmp/top.jsonl",
			}),
			session({
				id: "fork",
				path: "/tmp/fork.jsonl",
				firstMessage: "forked prompt",
				parentSessionPath: "/tmp/top.jsonl",
			}),
		];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const output = selector.render(120).join("\n");
		expect(output).toContain("top level prompt");
		expect(output).toContain("forked prompt");
		expect(output).not.toContain("code-reviewer#");
	});
});
