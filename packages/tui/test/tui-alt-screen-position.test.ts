import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// nredd/pi#30: reuse #29's actual root layout, not transcript text or a second entry map.
function fixture() {
	const terminal = new VirtualTerminal(80, 8);
	const before = new Text("wrap ".repeat(50), 0, 0);
	const entry = new Text(
		["ENTRY", ...Array.from({ length: 12 }, (_, index) => `inside ${index + 1}`)].join("\n"),
		0,
		0,
	);
	const tail = new Text("tail\n".repeat(12), 0, 0);
	const document = new VStack([before, entry, tail]);
	const scroll = new ScrollView(document, { primary: true, follow: "end" });
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scroll);
	tui.start();
	const paint = async () => {
		tui.renderNow();
		await terminal.flush();
	};
	const dispose = () => {
		tui.stop();
		terminal.dispose();
	};
	return { terminal, before, entry, tail, document, scroll, tui, paint, dispose };
}

describe("transcript viewport preservation", () => {
	it("preserves a native entry plus intra-entry position across resize reflow", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.tui.scrollToTop();
			f.tui.scrollBy(f.before.render(80).length + 3);
			await f.paint();
			assert.equal(f.terminal.getViewport()[0]?.trim(), "inside 3");
			f.terminal.resize(40, 8);
			await f.paint();
			assert.equal(f.terminal.getViewport()[0]?.trim(), "inside 3");
			assert.equal(f.scroll.isFollowingEnd, false);
		} finally {
			f.dispose();
		}
	});

	it("preserves the visible entry through an explicit framing change without changing its instance", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.tui.scrollToTop();
			f.tui.scrollBy(f.before.render(80).length + 2);
			await f.paint();
			f.tui.preserveTranscriptPosition();
			f.before.setText("metadata\n".repeat(20));
			await f.paint();
			assert.equal(f.terminal.getViewport()[0]?.trim(), "inside 2");
			assert.equal(f.document.children[1], f.entry);
		} finally {
			f.dispose();
		}
	});

	it("retains follow-end across framing changes and resize", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.tui.preserveTranscriptPosition();
			f.before.setText("metadata\n".repeat(20));
			await f.paint();
			f.terminal.resize(40, 6);
			await f.paint();
			assert.equal(f.scroll.isFollowingEnd, true);
			assert.ok(f.scroll.scrollTop > 0);
		} finally {
			f.dispose();
		}
	});
});
