import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Width used to render child components before they are folded into one row. Rendering wide keeps
 * each child's first logical line intact so truncation, not word wrap, decides where it ends.
 */
const UNWRAPPED_RENDER_WIDTH = 1000;

const SGR = "(?:\\x1b\\[[0-9;:]*m)*";
const LEADING_DECORATION = new RegExp(`^(${SGR})[\\s└├─│╰╭┌]+`);
const TRAILING_WHITESPACE = new RegExp(`\\s+(${SGR})$`);

function hasVisibleText(line: string): boolean {
	return stripTerminalSequences(line).trim().length > 0;
}

/** Removes trailing padding while keeping any closing style sequences. */
function trimEndVisible(line: string): string {
	let previous: string;
	let current = line;
	do {
		previous = current;
		current = current.replace(TRAILING_WHITESPACE, "$1");
	} while (current !== previous);
	return current;
}

/** Removes leading indentation and tree glyphs such as `└─ ` while keeping any opening style sequences. */
function trimStartDecoration(line: string): string {
	let previous: string;
	let current = line;
	do {
		previous = current;
		current = current.replace(LEADING_DECORATION, "$1");
	} while (current !== previous);
	return current;
}

/**
 * Returns the rows with visible text, stripped of padding and tree glyphs. Stops after `limit`
 * rows: collapsed rows read one or two lines of children that can hold thousands, every frame.
 */
export function contentLines(lines: readonly string[], limit = Number.POSITIVE_INFINITY): string[] {
	const content: string[] = [];
	for (const line of lines) {
		if (content.length >= limit) break;
		if (hasVisibleText(line)) content.push(trimEndVisible(trimStartDecoration(line)));
	}
	return content;
}

/** Returns the last non-blank line of plain text, trimmed. */
export function lastTextLine(text: string): string | undefined {
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return lines.at(-1)?.trim();
}

/** Returns the first non-blank line of plain text, trimmed. */
export function firstTextLine(text: string): string | undefined {
	return text
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim();
}

/**
 * Returns the first sentence of the first non-blank line: up to the first `.`, `!`, or `?` that
 * ends the line or precedes whitespace, else the whole line.
 */
export function firstSentence(text: string): string | undefined {
	const line = firstTextLine(text);
	if (line === undefined) return undefined;
	const match = /^(.*?[.!?])(?:\s|$)/.exec(line);
	return match ? match[1] : line;
}

/** Renders a component unwrapped and returns its first `limit` content lines. */
export function renderedContentLines(component: Component | undefined, limit = Number.POSITIVE_INFINITY): string[] {
	return component ? contentLines(component.render(UNWRAPPED_RENDER_WIDTH), limit) : [];
}

const SEPARATOR_WIDTH = 3;
const MAX_CACHED_WIDTHS = 4;

/**
 * Joins parts with a muted ` · ` and truncates the row to `width` with `…`. When the row
 * overflows, the head part gives up width first, down to half the row, so a long command or
 * path does not push the summary off screen.
 */
export function joinOneLine(parts: ReadonlyArray<string | undefined>, width: number): string {
	const present = parts.filter((part): part is string => part !== undefined && hasVisibleText(part));
	const [head, ...rest] = present;
	if (head === undefined) return "";
	const separator = theme.fg("muted", " · ");
	if (rest.length === 0) return truncateToWidth(head, width, "…");
	const tail = rest.join(separator);
	const headWidth = visibleWidth(head);
	const tailWidth = visibleWidth(tail);
	if (headWidth + SEPARATOR_WIDTH + tailWidth <= width) return `${head}${separator}${tail}`;
	const headBudget = Math.max(Math.ceil(width / 2), width - SEPARATOR_WIDTH - tailWidth);
	const fittedHead = headWidth > headBudget ? truncateToWidth(head, headBudget, "…") : head;
	return truncateToWidth(`${fittedHead}${separator}${tail}`, width, "…");
}

/**
 * A single-row view over a transcript entry. Each source is resolved at render time so renderers
 * that update in place (live status, streaming output) stay current.
 *
 * Resolving a source renders a child component, and the TUI renders every row on every frame, so
 * an uncached row costs O(transcript) per keystroke. Once `isSettled` reports true the row is
 * cached per width until `invalidate()`; owners rebuild the row whenever its entry changes.
 */
export class OneLineRow implements Component {
	private sources: ReadonlyArray<() => string | undefined>;
	private isSettled: () => boolean;
	/** Rendered lines per width: owners render the row at more than one width per frame. */
	private cached = new Map<number, string[]>();

	constructor(sources: ReadonlyArray<() => string | undefined>, isSettled: () => boolean = () => false) {
		this.sources = sources;
		this.isSettled = isSettled;
	}

	render(width: number): string[] {
		const hit = this.cached.get(width);
		if (hit) return hit;
		const line = joinOneLine(
			this.sources.map((source) => source()),
			width,
		);
		const lines = hasVisibleText(line) ? [line] : [];
		if (this.isSettled()) {
			// Resizes add widths; keep only the latest few.
			if (this.cached.size >= MAX_CACHED_WIDTHS) this.cached.clear();
			this.cached.set(width, lines);
		}
		return lines;
	}

	invalidate(): void {
		this.cached.clear();
	}
}
