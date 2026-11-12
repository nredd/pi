import { createHarness, fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { describe, expect, it } from "vitest";

// nredd/pi#30: completion time comes from the exact message, including deferred persistence.
describe("bash recorded time", () => {
	it("reports the recorded message before a streamed command is eventually persisted", async () => {
		let release!: () => void;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness();
		let turn: Promise<void> | undefined;
		try {
			harness.setResponses([
				async () => {
					started();
					await held;
					return fauxAssistantMessage("done");
				},
			]);
			turn = harness.session.prompt("hold");
			await ready;
			expect(harness.session.isStreaming).toBe(true);
			harness.session.recordBashResult("fixture", {
				output: "output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
			const [recorded] = harness.eventsOfType("bash_execution_recorded");
			expect(recorded).toBeDefined();
			expect(Number.isFinite(recorded!.message.timestamp)).toBe(true);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "bashExecution"),
			).toBe(false);
			release();
			await turn;
			const saved = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "bashExecution");
			expect(saved?.type === "message" && saved.message).toBe(recorded!.message);
			expect(harness.eventsOfType("bash_execution_recorded")).toHaveLength(1);
		} finally {
			release();
			await turn;
			harness.cleanup();
		}
	});
});
