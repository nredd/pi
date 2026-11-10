import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { DisclosureGutter } from "./disclosure-gutter.ts";
import { entryRule } from "./entry-rule.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { firstSentence, firstTextLine, OneLineRow, renderedContentLines } from "./one-line.ts";
import { RuledBlock } from "./ruled-block.ts";

/**
 * The collapsed thinking summary: the first sentence, or the whole first line when the sentence
 * would cut through `**bold**` (e.g. `**Done.** more`).
 */
function thinkingSummary(text: string): string | undefined {
	const sentence = firstSentence(text);
	if (sentence === undefined) return undefined;
	return (sentence.match(/\*\*/g)?.length ?? 0) % 2 === 0 ? sentence : firstTextLine(text);
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * A Markdown block of the last update. The next update reuses it at the same position for the same kind of content, so
 * a streamed answer keeps the blocks it already rendered, also once the stream ends.
 */
interface MarkdownSlot {
	kind: "text" | "thinking";
	markdown: Markdown;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private messageId?: string;
	private timestamp?: string;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	private markdownSlots: MarkdownSlot[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		// Markdown takes its padding at construction.
		this.markdownSlots = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousSlots = this.markdownSlots;
		this.markdownSlots = [];
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			const slot = previousSlots[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : create();
			markdown.setText(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};

		// Entry rules are added lazily, right before the next visible content block. This puts a rule
		// before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsRule = true;
		const addVisibleChild = (child: Component) => {
			if (needsRule) {
				this.contentContainer.addChild(entryRule());
				needsRule = false;
			}
			this.contentContainer.addChild(child);
		};

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant prose sits behind a left rule instead of a background; the rule takes the
				// place of outputPad so it lines up with the tool rows' disclosure gutter.
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = content.text.trim();
				addVisibleChild(
					new RuledBlock(
						markdownBlock(
							"text",
							text,
							() =>
								new Markdown(text, 0, 0, this.markdownTheme, undefined, {
									transform: createMarkdownTransform(
										"assistant",
										() => this.isStreaming,
										this.markdownTransformers,
										this.messageId,
										this.timestamp,
									),
								}),
						),
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				// A hidden run with an empty label renders nothing, including no spacing.
				if (hidden && !this.hiddenThinkingLabel.trim()) {
					continue;
				}
				const thinkingText = thinkingBlocks.join("\n\n");
				const dim = (text: string) => theme.italic(theme.fg("thinkingText", text));
				// Collapsed: `Thinking · <first sentence>`, one line like a tool row.
				const thinkingComponent = hidden
					? new OneLineRow(
							[
								// `Thinking...` -> `Thinking`: the collapsed row's head, before ` · <summary>`.
								() => dim(this.hiddenThinkingLabel.replace(/[.\u2026\s]+$/u, "") || this.hiddenThinkingLabel),
								() => {
									const summary = thinkingSummary(thinkingText);
									if (summary === undefined) return undefined;
									// Inline Markdown (bold headlines) through the same renderer as the expanded block.
									const rendered = new Markdown(summary, 0, 0, this.markdownTheme, {
										color: (text: string) => theme.fg("thinkingText", text),
										italic: true,
									});
									return renderedContentLines(rendered, 1)[0] ?? dim(summary);
								},
							],
							// A function of the captured `thinkingText` and label; `updateContent` rebuilds on change.
							true,
						)
					: markdownBlock(
							"thinking",
							thinkingText,
							() =>
								new Markdown(
									thinkingText,
									this.outputPad,
									0,
									this.markdownTheme,
									{
										color: (text: string) => theme.fg("thinkingText", text),
										italic: true,
									},
									{
										transform: createMarkdownTransform(
											"assistant-thinking",
											() => this.isStreaming,
											this.markdownTransformers,
											this.messageId,
											this.timestamp,
										),
									},
								),
						);
				addVisibleChild(
					new DisclosureGutter(
						thinkingComponent,
						() => !hidden,
						() => {
							this.thinkingVisibilityOverrides.set(runIndex, !hidden);
							if (this.lastMessage) this.updateContent(this.lastMessage);
						},
					),
				);
				// Add a rule only when another visible assistant content block follows.
				// This avoids a superfluous rule before separately-rendered tool execution blocks.
				needsRule = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
