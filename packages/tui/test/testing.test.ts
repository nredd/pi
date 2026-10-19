import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "@earendil-works/pi-tui/testing";

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
			assert.equal(renders, 1);
			text = "second";
			tui.requestRender();
			tui.flushRender();
			assert.equal(renders, 2);
			tui.flushRender();
			assert.equal(renders, 2);
			await terminal.flush();
			assert.equal(terminal.getViewport()[0], "second");
			await new Promise<void>((resolve) => process.nextTick(resolve));
			assert.equal(renders, 2);
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
			assert.equal(input, "raw\x1b[<0;1;1M");
			terminal.resize(30, 4);
			assert.equal(resizes, 1);
			assert.deepEqual([terminal.columns, terminal.rows], [30, 4]);
			terminal.write("\x1b[1;31mRED\x1b[0m normal");
			await terminal.flush();
			const cells = terminal.getStyledLine(0);
			assert.deepEqual(cells[0], { text: "R", bold: true, foreground: 1, foregroundMode: 16777216 });
			assert.equal(cells[4].bold, false);
			assert.notEqual(cells[4].foreground, cells[0].foreground);
			assert.deepEqual(terminal.getStyledLine(-1), []);
			terminal.write("\r\n1\r\n2\r\n3\r\n4\r\n5");
			await terminal.flush();
			assert.ok(terminal.getScrollBuffer().includes("RED normal"));
			assert.ok(terminal.getViewport().includes("5"));
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
			assert.equal(result.foreground, undefined);
			tui.flushRender();
			await terminal.flush();
			assert.ok(
				terminal
					.getViewport()
					.map((line) => line.trimEnd())
					.includes("frame"),
			);
		} finally {
			tui.stop();
			terminal.dispose();
		}
	});
});
