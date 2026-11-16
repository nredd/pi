import type { ThinkingContent } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownOptions, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Render provider-marked summary parts without inventing paragraphs between them.
 * Invalid/stale metadata falls back to the original thinking renderer without losing text. */
export function renderThinkingSummary(
	text: string,
	ranges: NonNullable<ThinkingContent["summaryRanges"]>,
	padding: number,
	markdownTheme: MarkdownTheme,
	options: MarkdownOptions,
): Container | undefined {
	let previousEnd = 0;
	if (
		ranges.length === 0 ||
		ranges.some(({ start, end }) => {
			const invalid =
				!Number.isInteger(start) ||
				!Number.isInteger(end) ||
				start < previousEnd ||
				end < start ||
				end > text.length;
			previousEnd = end;
			return invalid;
		})
	)
		return undefined;

	const result = new Container();
	let offset = 0;
	let summaryGroup: Container | undefined;
	for (const { start, end } of [...ranges, { start: text.length, end: text.length }]) {
		const full = text.slice(offset, start).trim();
		if (full) {
			if (result.children.length) result.addChild(new Spacer(1));
			result.addChild(
				new Markdown(
					full,
					padding,
					0,
					markdownTheme,
					{
						color: (value) => theme.fg("thinkingText", value),
						italic: true,
					},
					options,
				),
			);
			summaryGroup = undefined;
		}
		const summary = text.slice(start, end).trim();
		if (summary) {
			if (!summaryGroup) {
				if (result.children.length) result.addChild(new Spacer(1));
				const group = new Container();
				summaryGroup = group;
				result.addChild({
					render: (width) => {
						const lines = group.render(width);
						return lines.length
							? [...new Text(theme.fg("muted", "Summary"), padding, 0).render(width), ...lines]
							: [];
					},
					invalidate: () => group.invalidate(),
				});
			}
			summaryGroup.addChild(
				new Markdown(
					summary,
					padding,
					0,
					markdownTheme,
					{
						color: (value) => theme.fg("thinkingText", value),
					},
					options,
				),
			);
		}
		offset = end;
	}
	return result;
}
