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
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { DisclosureGutter } from "./disclosure-gutter.ts";
import { keyHint } from "./keybinding-hints.ts";

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
	private contentText: Text;
	private selfRenderContainer: Container;
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

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		const shell = this.hasRendererDefinition()
			? this.getRenderShell() === "self"
				? this.selfRenderContainer
				: this.contentBox
			: this.contentText;
		this.shellGutter = new DisclosureGutter(
			shell,
			() => (this.result && !this.isPartial ? this.expanded : undefined),
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
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
			outputPad: this.outputPad,
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
			/** Execution time of a final result. */
			durationMs?: number;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
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
				lines.push("");
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
		const headerRow = this.render(event.width).findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		const isPrimaryHeader =
			event.button === "left" &&
			event.y === headerRow &&
			!event.shift &&
			!event.alt &&
			!event.ctrl &&
			this.result &&
			!this.isPartial;
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

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
				renderContainer.setPaddingX(this.outputPad);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			// Renderers own their collapsed form via the `expanded` flag they are handed;
			// skipping them entirely hides tools whose summary row lives in `renderResult`.
			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setPaddingX(this.outputPad);
			this.contentText.setText(this.formatToolExecution());
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

		if (this.result) {
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
