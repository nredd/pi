import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	stripTerminalSequences,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";

/** What this component needs from a tool: how to draw it, without executing it. */
export type { ToolRenderers };

import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { ShellResultRenderComponent } from "../../../core/tools/renderers/bash.ts";
import { editRenderers } from "../../../core/tools/renderers/edit.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { DisclosureGutter } from "./disclosure-gutter.ts";
import { entryRule } from "./entry-rule.ts";
import { keyHint } from "./keybinding-hints.ts";
import { firstTextLine, lastTextLine, OneLineRow, renderedContentLines } from "./one-line.ts";

const FALLBACK_PREVIEW_LINES = 10;

function findChildRenderOffset(lines: readonly string[], childLines: readonly string[]): number {
	if (childLines.length === 0 || childLines.length > lines.length) return 0;
	for (let start = 0; start <= lines.length - childLines.length; start++) {
		if (childLines.every((line, index) => line === lines[start + index])) return start;
	}
	return 0;
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private compactBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private shellSlot: Container;
	private collapsedRow?: OneLineRow;
	private shellGutter: DisclosureGutter;
	private shellContainer: Container;
	private shellRenderHeight = 0;
	private shellRenderOffset = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	/** Inputs of imageComponents, so updateDisplay can reuse images and keep their converted PNG data. */
	private imageSources: Array<{ data: string; mimeType: string; widthCells: number }> = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
		durationMs?: number;
	};
	private hideComponent = false;
	/**
	 * Memoized `hasExpandableDetail()`; reset by every input change and renderer-requested invalidate.
	 * Not reset by `invalidate()`: the verdict compares unwrapped plain text, so theme and resize
	 * cannot change it, and recomputing per component per frame made full renders ~50% slower.
	 */
	private expandableDetail?: boolean;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = options.outputPad ?? 1;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(entryRule());

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		// compactBox carries the collapsed one-line row, so it drops the vertical padding.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.compactBox = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();
		// shellSlot holds whichever shell variant matches the current expanded state.
		this.shellSlot = new Container();

		// Running rows toggle too: expanding a live tool shows the output streamed so far.
		this.shellGutter = new DisclosureGutter(
			this.shellSlot,
			() => (this.hasExpandableDetail() ? this.expanded : undefined),
			() => this.setExpanded(!this.expanded),
		);
		this.shellContainer = new Container();
		this.shellContainer.addChild(this.shellGutter);
		this.addChild(this.shellContainer);

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	/**
	 * `probeState` marks a throwaway render: it gets its own renderer state and a no-op `invalidate`,
	 * because stateful renderers such as `edit` mutate and reuse their components and must not see a
	 * probe's expanded form. Flags stay honest, with one exception: the built-in `edit` renderer starts a
	 * background diff of the file on `argsComplete`, pure wasted I/O for a probe whose settled result
	 * already carries the diff, so only that renderer is probed with `argsComplete=false`.
	 */
	private getRenderContext(
		lastComponent: Component | undefined,
		expanded = this.expanded,
		probeState?: object,
	): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: probeState
				? () => {}
				: () => {
						// A renderer's own async state change may alter either form; theme/resize may not.
						this.expandableDetail = undefined;
						this.invalidate();
						this.ui.requestRender();
					},
			lastComponent,
			state: probeState ?? this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete && !(probeState && this.isBuiltInEdit()),
			isPartial: this.isPartial,
			expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
		};
	}

	private createCallFallback(expanded: boolean): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, expanded), 0, 0);
	}

	private createResultFallback(expanded: boolean): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.expandableDetail = undefined;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.expandableDetail = undefined;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.expandableDetail = undefined;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
			/** Execution time of a final result. */
			durationMs?: number;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.expandableDetail = undefined;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.expandableDetail = undefined;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.shellContainer.render(width);
			this.shellRenderHeight = contentLines.length;
			this.shellRenderOffset = 1;
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push(...entryRule().render(width));
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		if (this.collapsedRow && this.collapsedRow.render(width).length === 0) {
			return [];
		}

		const lines = super.render(width);
		const shellLines = this.shellContainer.render(width);
		this.shellRenderHeight = shellLines.length;
		this.shellRenderOffset = findChildRenderOffset(lines, shellLines);
		return lines;
	}

	/**
	 * Claims the header gesture here, then forwards shell rows to the disclosure gutter,
	 * which toggles on a plain body `click` without claiming `press` (see `DisclosureGutter`).
	 * The leading spacer and image rows stay inert.
	 */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const handled = {
			handled: true as const,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
		// The leading entry rule is a non-blank row; the header is the shell's first content row.
		const lines = this.render(event.width);
		const headerRow = lines.findIndex(
			(line, index) => index >= this.shellRenderOffset && stripTerminalSequences(line).trim().length > 0,
		);
		const isPrimaryHeader =
			event.button === "left" && event.y === headerRow && !event.shift && !event.alt && !event.ctrl;
		if (!this.hasExpandableDetail()) return undefined;
		if (event.type === "press" && isPrimaryHeader) return handled;
		if (event.type === "click" && isPrimaryHeader) {
			this.setExpanded(!this.expanded);
			return handled;
		}

		const shellY = event.y - this.shellRenderOffset;
		if (shellY < 0 || shellY >= this.shellRenderHeight) return undefined;
		return this.shellContainer.handleMouse({
			...event,
			y: shellY,
			height: this.shellRenderHeight,
		});
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		// A settled entry whose expansion adds nothing stays one row, whatever the expanded flag says.
		const collapsed = !this.expanded || !this.hasExpandableDetail();
		const selfShell = this.hasRendererDefinition() && this.getRenderShell() === "self";
		this.hideComponent = false;
		this.collapsedRow = undefined;
		this.shellSlot.clear();

		let hasContent = false;
		if (collapsed || this.hasRendererDefinition()) {
			// Collapsed rows always use compactBox so every one-line row shares the same framing.
			const renderContainer = collapsed ? this.compactBox : selfShell ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();
			this.shellSlot.addChild(renderContainer);

			const callComponent = this.renderCallComponent(!collapsed);
			const resultComponent = this.renderResultComponent(!collapsed);
			if (collapsed) {
				this.collapsedRow = new OneLineRow([
					() => renderedContentLines(callComponent)[0],
					() => this.getCollapsedResultLine(renderedContentLines(callComponent)[1], resultComponent),
				]);
				renderContainer.addChild(this.collapsedRow);
				hasContent = true;
			} else {
				for (const component of [callComponent, resultComponent]) {
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setPaddingX(this.outputPad);
			this.contentText.setText(this.formatToolExecution());
			this.shellSlot.addChild(this.contentText);
			hasContent = true;
		}

		const previousImages = this.imageComponents;
		const previousSources = this.imageSources;
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		this.imageSources = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result && !collapsed) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (const img of imageBlocks) {
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const source = { data: img.data, mimeType: img.mimeType, widthCells: this.imageWidthCells };
					const index = this.imageComponents.length;
					const previous = previousSources[index];
					const imageComponent =
						previous?.data === source.data &&
						previous.mimeType === source.mimeType &&
						previous.widthCells === source.widthCells
							? previousImages[index]
							: new Image(
									source.data,
									source.mimeType,
									{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
									{ maxWidthCells: source.widthCells },
								);
					if (source.mimeType !== "image/png") {
						ensurePngTranscoder(() => {
							this.invalidate();
							this.ui.requestRender();
						});
					}
					this.imageComponents.push(imageComponent);
					this.imageSources.push(source);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/** Renders the call row through the tool's renderer, falling back to `name args`. */
	private renderCallComponent(expanded: boolean, probeState?: object): Component {
		const callRenderer = this.hasRendererDefinition() ? this.getCallRenderer() : undefined;
		if (!callRenderer) return this.createCallFallback(expanded);
		try {
			const context = this.getRenderContext(
				probeState ? undefined : this.callRendererComponent,
				expanded,
				probeState,
			);
			const component = callRenderer(this.args, theme, context);
			if (!probeState) this.callRendererComponent = component;
			return component;
		} catch {
			if (!probeState) this.callRendererComponent = undefined;
			return this.createCallFallback(expanded);
		}
	}

	/**
	 * Renders the result through the tool's renderer. Renderers own their collapsed form via the
	 * `expanded` flag they are handed; skipping them entirely hides tools whose summary row lives
	 * in `renderResult`. `undefined` means there is no result renderer to ask.
	 */
	private renderResultComponent(expanded: boolean, probeState?: object): Component | undefined {
		if (!this.result) return undefined;
		const resultRenderer = this.hasRendererDefinition() ? this.getResultRenderer() : undefined;
		if (!resultRenderer) return expanded ? this.createResultFallback(expanded) : undefined;
		try {
			const component = resultRenderer(
				{ content: this.result.content as any, details: this.result.details },
				{ expanded, isPartial: this.isPartial },
				theme,
				this.getRenderContext(probeState ? undefined : this.resultRendererComponent, expanded, probeState),
			);
			if (!probeState) this.resultRendererComponent = component;
			return component;
		} catch {
			if (!probeState) this.resultRendererComponent = undefined;
			return expanded ? this.createResultFallback(expanded) : undefined;
		}
	}

	/**
	 * Whether expanding a settled entry would show anything its collapsed row does not. Both forms
	 * are rendered unwrapped and compared line by line (plain text), so the verdict is independent of
	 * terminal width. Running entries and entries with images always toggle: more output may arrive.
	 */
	private isBuiltInEdit(): boolean {
		return this.toolDefinition?.renderCall === editRenderers.renderCall;
	}

	private hasExpandableDetail(): boolean {
		this.expandableDetail ??= this.computeExpandableDetail();
		return this.expandableDetail;
	}

	private computeExpandableDetail(): boolean {
		if (!this.result || this.isPartial) return true;
		if (this.showImages && this.result.content.some((block) => block.type === "image")) return true;
		const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trim());
		const collapsedState = {};
		const expandedState = {};
		// Build both components before reading either: a renderer's result pass may rebuild its call component.
		const collapsedCallComponent = this.renderCallComponent(false, collapsedState);
		const collapsedResult = this.renderResultComponent(false, collapsedState);
		if (collapsedResult instanceof ShellResultRenderComponent && collapsedResult.hasExpandableOutput) return true;
		const collapsedCall = renderedContentLines(collapsedCallComponent);
		// Multiset, not set: expanded `same\nsame` against a collapsed `same` is extra detail.
		const remaining = new Map<string, number>();
		const collapsedParts = [collapsedCall[0], this.getCollapsedResultLine(collapsedCall[1], collapsedResult)];
		for (const line of plain(collapsedParts.filter((part): part is string => part !== undefined))) {
			remaining.set(line, (remaining.get(line) ?? 0) + 1);
		}
		const expandedCall = this.renderCallComponent(true, expandedState);
		const expandedResult = this.renderResultComponent(true, expandedState);
		const expandedLines = [...renderedContentLines(expandedCall), ...renderedContentLines(expandedResult)];
		return plain(expandedLines).some((line) => {
			const left = remaining.get(line) ?? 0;
			if (left === 0) return true;
			remaining.set(line, left - 1);
			return false;
		});
	}

	/**
	 * The summary half of a collapsed row: the first error line on failure, the result renderer's
	 * first line, the last output line while streaming, the call's second line for renderers that
	 * fold their summary into the call (e.g. `edit`, `write`), or a line count for plain text output.
	 */
	private getCollapsedResultLine(
		callSummary: string | undefined,
		resultComponent: Component | undefined,
	): string | undefined {
		if (!this.result) return callSummary;
		const output = this.getTextOutput();
		if (this.result.isError && !this.isPartial) {
			const errorLine = firstTextLine(output);
			if (errorLine) return theme.fg("error", errorLine);
		}
		const rendered = renderedContentLines(resultComponent)[0];
		if (rendered) return rendered;
		if (this.isPartial) {
			const lastLine = lastTextLine(output);
			if (lastLine) return theme.fg("toolOutput", lastLine);
		}
		if (callSummary) return callSummary;
		if (resultComponent || this.isPartial) return undefined;
		const lines = output.split("\n").filter((line) => line.trim().length > 0);
		if (lines.length === 0) return undefined;
		if (lines.length === 1) return theme.fg("toolOutput", lines[0]!.trim());
		return theme.fg("muted", `${lines.length} lines`);
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
