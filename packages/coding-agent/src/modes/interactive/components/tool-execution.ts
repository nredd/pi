import type { AgentToolResult } from "@earendil-works/pi-agent-core";
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
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

import { formatToolCallWithArgs, getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
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
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
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
	};
	private convertedImages: Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	> = new Map();
	private hideComponent = false;

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
			() => this.expanded,
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

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			if (sourceMimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			const index = i;
			convertToPng(sourceData, sourceMimeType).then((converted) => {
				const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
				if (!converted || currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
				this.convertedImages.set(index, {
					sourceData,
					sourceMimeType,
					...converted,
				});
				this.updateDisplay();
				this.ui.requestRender();
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
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

		const collapsed = !this.expanded;
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
			}
			renderContainer.clear();
			this.shellSlot.addChild(renderContainer);

			const callComponent = this.renderCallComponent();
			const resultComponent = this.renderResultComponent();
			if (collapsed) {
				this.collapsedRow = new OneLineRow([
					() => renderedContentLines(callComponent)[0],
					() => this.getCollapsedResultLine(callComponent, resultComponent),
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
			this.contentText.setText(this.formatToolExecution());
			this.shellSlot.addChild(this.contentText);
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result && !collapsed) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/** Renders the call row through the tool's renderer, falling back to `name args`. */
	private renderCallComponent(): Component {
		const callRenderer = this.hasRendererDefinition() ? this.getCallRenderer() : undefined;
		if (!callRenderer) return this.createCallFallback();
		try {
			const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
			this.callRendererComponent = component;
			return component;
		} catch {
			this.callRendererComponent = undefined;
			return this.createCallFallback();
		}
	}

	/**
	 * Renders the result through the tool's renderer. Renderers own their collapsed form via the
	 * `expanded` flag they are handed; skipping them entirely hides tools whose summary row lives
	 * in `renderResult`. `undefined` means there is no result renderer to ask.
	 */
	private renderResultComponent(): Component | undefined {
		if (!this.result) return undefined;
		const resultRenderer = this.hasRendererDefinition() ? this.getResultRenderer() : undefined;
		if (!resultRenderer) return this.expanded ? this.createResultFallback() : undefined;
		try {
			const component = resultRenderer(
				{ content: this.result.content as any, details: this.result.details },
				{ expanded: this.expanded, isPartial: this.isPartial },
				theme,
				this.getRenderContext(this.resultRendererComponent),
			);
			this.resultRendererComponent = component;
			return component;
		} catch {
			this.resultRendererComponent = undefined;
			return this.expanded ? this.createResultFallback() : undefined;
		}
	}

	/**
	 * The summary half of a collapsed row: the first error line on failure, the result renderer's
	 * first line, the last output line while streaming, the call's second line for renderers that
	 * fold their summary into the call (e.g. `edit`, `write`), or a line count for plain text output.
	 */
	private getCollapsedResultLine(
		callComponent: Component,
		resultComponent: Component | undefined,
	): string | undefined {
		const callSummary = renderedContentLines(callComponent)[1];
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
