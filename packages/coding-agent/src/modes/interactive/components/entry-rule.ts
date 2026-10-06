import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

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

	constructor(glyph: string) {
		this.glyph = glyph;
	}

	render(width: number): string[] {
		return [theme.fg("borderMuted", this.glyph.repeat(Math.max(1, width)))];
	}

	invalidate(): void {}
}

export function entryRule(): Rule {
	return new Rule(ENTRY_RULE_GLYPH);
}

export function turnRule(): Rule {
	return new Rule(TURN_RULE_GLYPH);
}

/** True when a rendered row (ANSI stripped or not) is an entry rule. */
export function isEntryRule(line: string): boolean {
	const plain = line.replace(/\x1b\[[0-9;:]*m/g, "").trim();
	return plain.length > 0 && [...plain].every((character) => character === ENTRY_RULE_GLYPH);
}
