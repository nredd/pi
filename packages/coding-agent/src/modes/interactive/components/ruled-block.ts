import type { Component } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

export const RULE_WIDTH = 2;

/**
 * Prefixes every line of a child, blank ones included, with a `│ ` rule so a block of prose
 * reads as one entry next to the gutter-marked tool rows. The rule takes the same two columns
 * as a disclosure gutter, so content stays aligned across roles.
 */
export class RuledBlock implements Component {
	private child: Component;
	private color: ThemeColor;

	constructor(child: Component, color: ThemeColor = "borderAccent") {
		this.child = child;
		this.color = color;
	}

	render(width: number): string[] {
		if (width <= RULE_WIDTH) return this.child.render(width);
		const rule = `${theme.fg(this.color, "│")} `;
		return this.child.render(width - RULE_WIDTH).map((line) => `${rule}${line}`);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
