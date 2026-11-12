import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// nredd/pi#29: exercise the real root layout and primary transcript, not a parallel navigator.
function fixture(rows = 5) {
	const terminal = new VirtualTerminal(40, rows);
	const first = new Text("first\nfirst continued\nfirst end", 0, 0);
	const between = new Text("assistant\ntool\noutput\noutput", 0, 0);
	const second = new Text("second\nsecond end", 0, 0);
	const after = new Text("tail", 0, 0);
	const document = new VStack([first, between, second, after]);
	const scroll = new ScrollView(document, { primary: true, follow: "end" });
	const tui = new TuiAltScreen(terminal);
	const identities = [{}, {}];
	tui.setTranscriptNavigationTargets([
		{ identity: identities[0]!, component: first },
		{ identity: identities[1]!, component: second },
	]);
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
	return { terminal, first, between, second, after, document, scroll, tui, identities, paint, dispose };
}

describe("semantic transcript navigation", () => {
	it("selects latest from live bottom even when already visible, advances through clamped targets, and restores follow", async () => {
		const f = fixture();
		try {
			await f.paint();
			assert.equal(f.scroll.scrollTop, 5);
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			assert.equal(f.scroll.scrollTop, 5); // second starts at 7, cannot align without blank rows
			assert.equal(f.scroll.isFollowingEnd, false);
			await f.paint();
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			assert.equal(f.scroll.scrollTop, 0);
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), false);
			assert.equal(f.scroll.isFollowingEnd, false);
			f.tui.scrollToBottom();
			assert.equal(f.scroll.isFollowingEnd, true);
		} finally {
			f.dispose();
		}
	});

	it("uses viewport top after manual scrolling: partial prompt -> its start, aligned -> earlier prompt", async () => {
		const f = fixture(2);
		try {
			await f.paint();
			f.tui.scrollToTop();
			f.tui.scrollBy(8);
			await f.paint();
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			assert.equal(f.scroll.scrollTop, 7);
			await f.paint();
			f.tui.scrollBy(-1);
			f.tui.scrollBy(1);
			await f.paint();
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			assert.equal(f.scroll.scrollTop, 0);
		} finally {
			f.dispose();
		}
	});

	it("reanchors selected identity after streaming, disclosure, resize and replay without padding", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.tui.scrollToPreviousTranscriptTarget();
			f.after.setText(Array.from({ length: 20 }, (_, i) => `stream ${i}`).join("\n"));
			await f.paint();
			assert.equal(f.scroll.scrollTop, 7);
			f.between.setText("expanded\n".repeat(12));
			await f.paint();
			assert.equal(f.terminal.getViewport()[0]?.trim(), "second");
			f.terminal.resize(20, 3);
			await f.paint();
			assert.equal(f.terminal.getViewport()[0]?.trim(), "second");
			const replay = new Text("replayed second", 0, 0);
			f.document.removeChild(f.second);
			f.document.addChild(replay);
			f.tui.setTranscriptNavigationTargets([
				{ identity: f.identities[0]!, component: f.first },
				{ identity: f.identities[1]!, component: replay },
			]);
			await f.paint();
			assert.equal(f.scroll.isFollowingEnd, false);
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			assert.equal(f.scroll.scrollTop, 0);
		} finally {
			f.dispose();
		}
	});

	it("discards removed or session-replaced identities and leaves empty navigation unchanged", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.tui.scrollToPreviousTranscriptTarget();
			f.document.removeChild(f.second);
			await f.paint();
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), true);
			f.tui.resetTranscriptNavigation();
			f.tui.scrollToBottom();
			const before = f.scroll.scrollTop;
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), false);
			assert.equal(f.scroll.scrollTop, before);
			assert.equal(f.scroll.isFollowingEnd, true);
		} finally {
			f.dispose();
		}
	});

	it("respects overlays and preserves selection on pure navigation without copying", async () => {
		const f = fixture();
		try {
			await f.paint();
			f.terminal.sendInput("\x1b[<0;1;1M");
			f.terminal.sendInput("\x1b[<32;3;1M");
			await f.paint();
			assert.equal(f.tui.hasActiveSelection(), true);
			f.tui.scrollToPreviousTranscriptTarget();
			await f.paint();
			assert.equal(f.tui.hasActiveSelection(), true);
			const overlay = f.tui.showOverlay(new Text("dialog", 0, 0));
			assert.equal(f.tui.scrollToPreviousTranscriptTarget(), false);
			overlay.hide();
			f.terminal.resize(25, 5);
			await f.paint();
			assert.equal(f.tui.hasActiveSelection(), true); // no selected row reflowed
			f.between.setText("replacement rows");
			await f.paint();
			assert.equal(f.tui.hasActiveSelection(), false);
		} finally {
			f.dispose();
		}
	});
});
