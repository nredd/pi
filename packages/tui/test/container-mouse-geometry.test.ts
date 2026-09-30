import assert from "node:assert";
import { describe, it } from "node:test";
import { Spacer } from "../src/components/spacer.ts";
import { Text } from "../src/components/text.ts";
import {
	type Component,
	Container,
	resolveContainerRowOffset,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
} from "../src/tui.ts";

function mouse(type: TuiMouseEventType, x: number, y: number, width = 40, height = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

/** Records the local row each click lands on, mirroring a disclosure header hit test. */
class ClickProbe implements Component {
	readonly rows: number[] = [];
	private readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	render(_width: number): string[] {
		return [this.label];
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.rows.push(event.y);
		return { handled: true };
	}
}

/** Container whose public render drops the leading blank line, as extensions do. */
class LeadingTrimContainer extends Container {
	override render(width: number): string[] {
		const lines = super.render(width);
		return lines[0] !== undefined && lines[0].trim().length === 0 ? lines.slice(1) : lines;
	}
}

describe("container mouse geometry", () => {
	it("keeps naive mapping when render is untransformed", () => {
		const container = new Container();
		const first = new ClickProbe("first");
		const second = new ClickProbe("second");
		container.addChild(new Spacer(1));
		container.addChild(first);
		container.addChild(second);
		container.render(40);

		assert.strictEqual(container.handleMouse(mouse("click", 0, 1))?.handled, true);
		assert.deepStrictEqual(first.rows, [0]);
		assert.strictEqual(container.handleMouse(mouse("click", 0, 2))?.handled, true);
		assert.deepStrictEqual(second.rows, [0]);
	});

	it("shifts clicks back through a leading blank-line trim", () => {
		const transcript = new Container();
		const message = new LeadingTrimContainer();
		const header = new ClickProbe("header");
		const body = new ClickProbe("body");
		message.addChild(new Spacer(1));
		message.addChild(header);
		message.addChild(body);
		transcript.addChild(message);
		assert.deepStrictEqual(transcript.render(40), ["header", "body"]);

		// Row 0 on screen is the header, even though it is row 1 inside the message.
		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 0))?.handled, true);
		assert.deepStrictEqual(header.rows, [0]);
		assert.deepStrictEqual(body.rows, []);

		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 1))?.handled, true);
		assert.deepStrictEqual(body.rows, [0]);
	});

	it("survives a render patch installed after the first render", () => {
		const transcript = new Container();
		const message = new Container();
		const header = new ClickProbe("header");
		message.addChild(new Spacer(1));
		message.addChild(header);
		transcript.addChild(message);
		transcript.render(40);

		const original = message.render.bind(message);
		message.render = (width: number) => {
			const lines = original(width);
			return lines[0]?.trim().length === 0 ? lines.slice(1) : lines;
		};
		transcript.render(40);

		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 0))?.handled, true);
		assert.deepStrictEqual(header.rows, [0]);
	});

	it("drops events when a transform cannot be aligned", () => {
		class ReplacingContainer extends Container {
			override render(width: number): string[] {
				super.render(width);
				return ["something", "entirely", "different"];
			}
		}
		const transcript = new Container();
		const message = new ReplacingContainer();
		const probe = new ClickProbe("header");
		message.addChild(probe);
		transcript.addChild(message);
		transcript.render(40);

		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 0)), undefined);
		assert.deepStrictEqual(probe.rows, []);
	});

	it("maps rows through trailing-only transforms unchanged", () => {
		class TrailingPadContainer extends Container {
			override render(width: number): string[] {
				return [...super.render(width), ""];
			}
		}
		const transcript = new Container();
		const message = new TrailingPadContainer();
		const probe = new ClickProbe("header");
		message.addChild(probe);
		transcript.addChild(message);
		transcript.render(40);

		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 0))?.handled, true);
		assert.deepStrictEqual(probe.rows, [0]);
	});

	it("resolves row offsets from blank-line differences", () => {
		assert.strictEqual(resolveContainerRowOffset(["", "a", "b"], ["a", "b"]), 1);
		assert.strictEqual(resolveContainerRowOffset(["a", "b"], ["a", "b"]), 0);
		assert.strictEqual(resolveContainerRowOffset(["a"], ["", "a"]), -1);
		assert.strictEqual(resolveContainerRowOffset(["a"], ["b"]), undefined);
		assert.strictEqual(resolveContainerRowOffset([""], ["", ""]), undefined);
	});

	it("ignores styling when anchoring rows", () => {
		const transcript = new Container();
		const message = new LeadingTrimContainer();
		const styled = new Text("\x1b[1mheader\x1b[22m", 0, 0);
		const probe = new ClickProbe("body");
		message.addChild(new Spacer(1));
		message.addChild(styled);
		message.addChild(probe);
		transcript.addChild(message);
		transcript.render(40);

		assert.strictEqual(transcript.handleMouse(mouse("click", 0, 1))?.handled, true);
		assert.deepStrictEqual(probe.rows, [0]);
	});
});
