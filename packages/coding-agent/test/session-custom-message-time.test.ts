import { describe, expect, it } from "vitest";
import { SessionManager, sessionEntryToContextMessages } from "../src/core/session-manager.ts";

// nredd/pi#30: preserve the recorded message instant in the existing ISO field, not a new format.
describe("custom message recorded time", () => {
	it.each([0, -1, Date.parse("2000-06-01T12:34:56Z")])("persists and replays the supplied instant %s", (timestamp) => {
		const manager = SessionManager.inMemory("/tmp");
		const id = manager.appendCustomMessageEntry("example", "content", true, undefined, timestamp);
		const entry = manager.getEntry(id)!;
		expect(entry.timestamp).toBe(new Date(timestamp).toISOString());
		expect(sessionEntryToContextMessages(entry)[0]?.timestamp).toBe(timestamp);
		expect(Object.keys(entry).sort()).toEqual([
			"content",
			"customType",
			"details",
			"display",
			"id",
			"parentId",
			"timestamp",
			"type",
		]);
	});

	it.each([undefined, NaN, Infinity, -Infinity, 9e20])(
		"retains native entry-recording time when message time is absent/invalid: %s",
		(timestamp) => {
			const manager = SessionManager.inMemory("/tmp");
			const id = manager.appendCustomMessageEntry("example", "content", true, undefined, timestamp);
			const entry = manager.getEntry(id)!;
			expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
			expect(sessionEntryToContextMessages(entry)[0]?.timestamp).toBe(Date.parse(entry.timestamp));
		},
	);
});
