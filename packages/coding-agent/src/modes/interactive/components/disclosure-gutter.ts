import { type Component, dispatchMouseEvent, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";

const GUTTER_WIDTH = 2;

/**
 * Reserves a two-column disclosure gutter without changing a child's mouse surface.
 * `undefined` hides the marker while retaining the gutter, which keeps streaming
 * tool rows aligned with their completed form.
 */
export class DisclosureGutter implements Component {
	private child: Component;
	private getExpanded: () => boolean | undefined;
	private onToggle?: () => void;

	constructor(child: Component, getExpanded: () => boolean | undefined, onToggle?: () => void) {
		this.child = child;
		this.getExpanded = getExpanded;
		this.onToggle = onToggle;
	}

	render(width: number): string[] {
		if (width <= GUTTER_WIDTH) return this.child.render(width);
		const lines = this.child.render(width - GUTTER_WIDTH);
		const expanded = this.getExpanded();
		const firstContentLine = lines.findIndex((line) => stripTerminalSequences(line).trim().length > 0);
		const markerLine = Math.max(0, firstContentLine);
		return lines.map((line, index) => {
			const marker = index === markerLine && expanded !== undefined ? (expanded ? "▾" : "▸") : " ";
			return `${marker} ${line}`;
		});
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		if (
			event.type === "click" &&
			event.button === "left" &&
			event.x < GUTTER_WIDTH &&
			this.getExpanded() !== undefined &&
			this.onToggle
		) {
			this.onToggle();
			return { handled: true };
		}
		if (!this.child.handleMouse) return undefined;
		if (event.width <= GUTTER_WIDTH) return dispatchMouseEvent(this.child, event);
		return dispatchMouseEvent(this.child, {
			...event,
			x: Math.max(0, event.x - GUTTER_WIDTH),
			width: event.width - GUTTER_WIDTH,
		});
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
