import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "@earendil-works/pi-tui/testing";
import { describe, expect, it } from "vitest";

describe("testing terminal and render flush", () => {
	it("flushes only pending frames synchronously without waiting for the throttle", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiMainScreen(terminal);
		let renders = 0;
		let text = "first";
		tui.addChild({
			render: () => {
				renders++;
				return [text];
			},
			invalidate() {},
		});
		tui.start();
		try {
			tui.flushRender();
			expect(renders).toBe(1);
			text = "second";
			tui.requestRender();
			tui.flushRender();
			expect(renders).toBe(2);
			tui.flushRender();
			expect(renders).toBe(2);
			await terminal.flush();
			expect(terminal.getViewport()[0]).toBe("second");
			await new Promise<void>((resolve) => process.nextTick(resolve));
			expect(renders).toBe(2);
		} finally {
			tui.stop();
			terminal.dispose();
		}
	});

	it("inspects styles, input, resize and scrollback through the public terminal", async () => {
		const terminal = new VirtualTerminal(20, 3);
		let input = "";
		let resizes = 0;
		terminal.start(
			(data) => {
				input += data;
			},
			() => {
				resizes++;
			},
		);
		try {
			terminal.sendInput("raw\x1b[<0;1;1M");
			expect(input).toBe("raw\x1b[<0;1;1M");
			terminal.resize(30, 4);
			expect(resizes).toBe(1);
			expect([terminal.columns, terminal.rows]).toEqual([30, 4]);
			terminal.write("\x1b[1;31mRED\x1b[0m normal");
			await terminal.flush();
			const cells = terminal.getStyledLine(0);
			expect(cells[0]).toEqual({ text: "R", bold: true, foreground: 1, foregroundMode: 16777216 });
			expect(cells[4].bold).toBe(false);
			expect(cells[4].foreground).not.toBe(cells[0].foreground);
			expect(terminal.getStyledLine(-1)).toEqual([]);
			terminal.write("\r\n1\r\n2\r\n3\r\n4\r\n5");
			await terminal.flush();
			expect(terminal.getScrollBuffer()).toContain("RED normal");
			expect(terminal.getViewport()).toContain("5");
		} finally {
			terminal.dispose();
		}
	});

	it("completes terminal queries without a timeout", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Text("frame", 0, 0));
		tui.start();
		try {
			const result = await tui.queryTerminalColors({ timeoutMs: 60_000 });
			expect(result.foreground).toBeUndefined();
			tui.flushRender();
			await terminal.flush();
			expect(terminal.getViewport().map((line) => line.trimEnd())).toContain("frame");
		} finally {
			tui.stop();
			terminal.dispose();
		}
	});
});
