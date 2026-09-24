import { type Component, MouseRegion, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";

const GUTTER_WIDTH = 2;

/**
 * Reserves a two-column disclosure gutter without changing a child's mouse surface.
 * `undefined` hides the marker while retaining the gutter, which keeps streaming
 * tool rows aligned with their completed form.
 *
 * The header row claims the whole press/click gesture. Every other row toggles only on
 * the synthetic `click` the TUI emits after an unhandled press/release, so body rows
 * never claim `press` and drag-selection plus OSC 8 links keep working.
 */
export class DisclosureGutter implements Component {
	private childRegion: MouseRegion;
	private getExpanded: () => boolean | undefined;
	private onToggle?: () => void;

	constructor(child: Component, getExpanded: () => boolean | undefined, onToggle?: () => void) {
		this.childRegion = new MouseRegion(child, () => undefined);
		this.getExpanded = getExpanded;
		this.onToggle = onToggle;
	}

	render(width: number): string[] {
		if (width <= GUTTER_WIDTH) return this.childRegion.render(width);
		const lines = this.childRegion.render(width - GUTTER_WIDTH);
		const expanded = this.getExpanded();
		const firstContentLine = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		const markerLine = Math.max(0, firstContentLine);
		return lines.map((line, index) => {
			const marker = index === markerLine && expanded !== undefined ? (expanded ? "▾" : "▸") : " ";
			return `${marker} ${line}`;
		});
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		const childWidth = event.width - GUTTER_WIDTH;
		const lines = childWidth > 0 ? this.childRegion.render(childWidth) : [];
		const headerRow = Math.max(
			0,
			lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0),
		);
		const toggle = this.onToggle;
		const isPrimaryToggle =
			event.button === "left" &&
			!event.shift &&
			!event.alt &&
			!event.ctrl &&
			this.getExpanded() !== undefined &&
			toggle !== undefined;
		const isPrimaryHeader = isPrimaryToggle && event.y === headerRow;
		if (event.type === "press" && isPrimaryHeader) return { handled: true };
		if (event.type === "click" && isPrimaryHeader) {
			toggle();
			return { handled: true };
		}
		const childResult =
			event.width <= GUTTER_WIDTH
				? this.childRegion.handleMouse(event)
				: this.childRegion.handleMouse({
						...event,
						x: Math.max(0, event.x - GUTTER_WIDTH),
						width: childWidth,
					});
		if (childResult) return childResult;
		if (event.type === "click" && isPrimaryToggle && event.y >= 0 && event.y < lines.length) {
			toggle();
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {
		this.childRegion.invalidate();
	}
}
