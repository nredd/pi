import { type Component, copyGutterEndMarker, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { EntryTimestamp } from "./entry-timestamp.ts";

/** Between two entries of the same turn. Dashed, so it is lighter than the turn rule. */
export const ENTRY_RULE_GLYPH = "┄";
/** Above every user prompt after the first. */
export const TURN_RULE_GLYPH = "─";

/**
 * A full-width muted rule. Transcript entries are separated by one of these instead of a blank
 * line, so the transcript never shows `rule, blank, rule`.
 */
export class Rule implements Component {
	private glyph: string;
	readonly entryTimestamp: EntryTimestamp;

	constructor(glyph: string, timestamp?: EntryTimestamp) {
		this.glyph = glyph;
		this.entryTimestamp = timestamp ?? new EntryTimestamp();
	}

	/** A native owner may decorate its existing rule after rendering visible content once. */
	render(width: number, timestamp = this.entryTimestamp): string[] {
		const label = timestamp.label(width - 2);
		if (label !== undefined) {
			const prefix = `${theme.fg("borderMuted", this.glyph)} ${label}`;
			return [
				prefix +
					theme.fg("borderMuted", this.glyph.repeat(Math.max(0, width - visibleWidth(prefix)))) +
					copyGutterEndMarker(),
			];
		}
		return [theme.fg("borderMuted", this.glyph.repeat(Math.max(1, width))) + copyGutterEndMarker()];
	}

	invalidate(): void {}
}

export function entryRule(timestamp?: EntryTimestamp): Rule {
	return new Rule(ENTRY_RULE_GLYPH, timestamp);
}

/** True when a rendered row (ANSI stripped or not) is an entry rule. */
export function isEntryRule(line: string): boolean {
	const plain = stripTerminalSequences(line).trim();
	return plain.length > 0 && [...plain].every((character) => character === ENTRY_RULE_GLYPH);
}
