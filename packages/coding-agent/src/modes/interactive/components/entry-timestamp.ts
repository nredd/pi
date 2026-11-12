import { type Component, copyGutterEndMarker, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Recorded display time. Numeric message times take precedence over persisted entry ISO times. */
export interface EntryTime {
	messageTimestamp?: number;
	entryTimestamp?: string;
}

/** Resolve recorded time only. Never substitute the clock of a render, reload, or resume. */
export function resolveEntryTime(time: EntryTime): number | undefined {
	if (typeof time.messageTimestamp === "number" && Number.isFinite(time.messageTimestamp)) {
		const date = new Date(time.messageTimestamp);
		if (Number.isFinite(date.getTime())) return date.getTime();
	}
	// Session entries persist ISO instants with a timezone, not locale-dependent date strings.
	if (typeof time.entryTimestamp !== "string") return undefined;
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
		time.entryTimestamp,
	);
	if (!parts) return undefined;
	const [, year, month, day, hour, minute, second] = parts.map(Number);
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month, 0);
	if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || hour > 23 || minute > 59 || second > 59)
		return undefined;
	const timestamp = Date.parse(time.entryTimestamp);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Viewer-local label with an explicit date and UTC offset, including repeated DST hours. */
export function formatEntryTimestamp(timestamp: number): string | undefined {
	if (!Number.isFinite(timestamp)) return undefined;
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime()) || date.getFullYear() < 0 || date.getFullYear() > 9999) return undefined;
	const pad = (value: number) => String(value).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/**
 * Core-owned entry decoration, shared by native and extension-rendered rows. Changing this state
 * never invalidates message/tool content caches, replaces their instances, or starts a timer.
 */
export class EntryTimestamp implements Component {
	private timestamp?: number;
	private enabled = false;

	setTime(time: EntryTime): void {
		this.timestamp = resolveEntryTime(time);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/** Omit the whole label when it cannot fit; a partial date could imply a different instant. */
	label(width: number): string | undefined {
		if (!this.enabled || this.timestamp === undefined) return undefined;
		const label = formatEntryTimestamp(this.timestamp);
		return label !== undefined && visibleWidth(label) <= width ? theme.fg("muted", label) : undefined;
	}

	/** Reuse a leading padding row, retaining the original blank output while disabled. */
	padding(width: number, paddingX = 0, background?: (text: string) => string): string[] {
		const label = this.label(width - paddingX * 2);
		if (label === undefined) return [background ? background(" ".repeat(width)) : ""];
		const content = " ".repeat(paddingX) + label;
		const row = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
		return [(background ? background(row) : row) + copyGutterEndMarker()];
	}

	/** Metadata slot for an entry without an existing separator. Hidden state takes no rows. */
	render(width: number): string[] {
		const label = this.label(width);
		return label === undefined ? [] : [label + copyGutterEndMarker()];
	}

	invalidate(): void {}
}
