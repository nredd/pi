import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VirtualTerminal } from "../src/testing/virtual-terminal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	failFrame = false;
	override write(data: string): void {
		if (this.failFrame && data.includes("\x1b[?2026l")) throw new Error("synthetic write failure");
		this.writes.push(data);
		super.write(data);
	}
}

// nredd/pi#51: logical frame writes are not display acknowledgements.
describe("first logical commit", () => {
	for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
		it(`${Renderer.name} ignores controls and styled blanks, then reports once after writing`, async () => {
			const terminal = new RecordingTerminal();
			const tui = new Renderer(terminal);
			let text = "\x1b[31m  \x1b[0m";
			tui.addChild({ render: () => [text], invalidate() {} });
			let commits = 0;
			tui.onFirstCommit = () => {
				assert.match(terminal.writes.join(""), /visible frame/);
				assert.ok(terminal.writes.some((data) => data.includes("\x1b[?2026l")));
				commits++;
			};
			try {
				tui.start();
				tui.renderNow();
				assert.equal(commits, 0);
				text = "visible frame";
				tui.renderNow();
				tui.renderNow(true);
				assert.equal(commits, 1);
			} finally {
				tui.stop();
				await terminal.flush();
				terminal.dispose();
			}
		});
		it(`${Renderer.name} does not report a failed frame write`, async () => {
			const terminal = new RecordingTerminal();
			const tui = new Renderer(terminal);
			tui.addChild({ render: () => ["visible frame"], invalidate() {} });
			let commits = 0;
			tui.onFirstCommit = () => {
				commits++;
			};
			try {
				tui.start();
				terminal.failFrame = true;
				assert.throws(() => tui.renderNow(), /synthetic write failure/);
				assert.equal(commits, 0);
			} finally {
				terminal.failFrame = false;
				tui.stop();
				await terminal.flush();
				terminal.dispose();
			}
		});
	}
});
