import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getCopyRowInfo, setCopyMarkersEnabled } from "../../tui/src/utils.ts";
import { entryRule } from "../src/modes/interactive/components/entry-rule.ts";
import {
	EntryTimestamp,
	formatEntryTimestamp,
	resolveEntryTime,
} from "../src/modes/interactive/components/entry-timestamp.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// nredd/pi#30: timestamps describe recorded instants, never the render clock.
describe("recorded entry timestamps", () => {
	const timezone = process.env.TZ;
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		setCopyMarkersEnabled(false);
		if (timezone === undefined) delete process.env.TZ;
		else process.env.TZ = timezone;
	});

	it("prefers numeric message time, including epoch zero, then persisted ISO time", () => {
		expect(resolveEntryTime({ messageTimestamp: 0, entryTimestamp: "2026-01-01T00:00:00Z" })).toBe(0);
		for (const messageTimestamp of [undefined, NaN, Infinity, -Infinity, 9e20]) {
			expect(resolveEntryTime({ messageTimestamp, entryTimestamp: "1970-01-01T01:00:00+01:00" })).toBe(0);
		}
	});

	it.each([
		undefined,
		"",
		"now",
		"2026-01-01",
		"2026-01-01T00:00:00",
		"2026-02-30T00:00:00Z",
		"2026-13-01T00:00:00Z",
		"2026-01-01T24:00:00Z",
	])("omits invalid or unknown recorded entry time: %s", (entryTimestamp) => {
		expect(resolveEntryTime({ entryTimestamp })).toBeUndefined();
	});

	it("formats midnight and year boundaries in viewer-local time", () => {
		process.env.TZ = "UTC";
		expect(formatEntryTimestamp(0)).toBe("1970-01-01 00:00:00 +00:00");
		expect(formatEntryTimestamp(Date.parse("2025-12-31T23:59:59Z"))).toBe("2025-12-31 23:59:59 +00:00");
		process.env.TZ = "Asia/Kathmandu";
		expect(formatEntryTimestamp(Date.parse("2025-12-31T23:59:59Z"))).toBe("2026-01-01 05:44:59 +05:45");
	});

	it("distinguishes both occurrences of a repeated DST hour", () => {
		process.env.TZ = "America/New_York";
		expect(formatEntryTimestamp(Date.parse("2026-11-01T05:30:00Z"))).toBe("2026-11-01 01:30:00 -04:00");
		expect(formatEntryTimestamp(Date.parse("2026-11-01T06:30:00Z"))).toBe("2026-11-01 01:30:00 -05:00");
	});

	it.each([NaN, Infinity, -Infinity, 9e20])("omits unrepresentable numeric time: %s", (timestamp) => {
		expect(formatEntryTimestamp(timestamp)).toBeUndefined();
	});

	it.each([20, 40, 80, 120])(
		"uses only the existing rule row at width %i and excludes metadata from selection",
		(width) => {
			process.env.TZ = "UTC";
			setCopyMarkersEnabled(true);
			const decoration = new EntryTimestamp();
			decoration.setTime({ messageTimestamp: 0 });
			const rule = entryRule(decoration);
			const baseline = rule.render(width);
			expect(stripTerminalSequences(baseline[0])).toBe("┄".repeat(width));
			decoration.setEnabled(true);
			const lines = rule.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBe(width);
			if (width >= 28) {
				expect(stripTerminalSequences(lines[0])).toContain("1970-01-01 00:00:00 +00:00");
				expect(getCopyRowInfo(lines[0]).gutterEnd).toBe(width);
			} else {
				expect(lines).toEqual(baseline);
			}
			decoration.setEnabled(false);
			expect(rule.render(width)).toEqual(baseline);
		},
	);
});
