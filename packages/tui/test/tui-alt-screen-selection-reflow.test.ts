import assert from "node:assert/strict";
import { it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function selectedFixture(text = "START alpha beta gamma delta epsilon zeta eta theta iota kappa lambda END") {
	const terminal = new VirtualTerminal(80, 40);
	const before = new Text("prefix ".repeat(20), 0, 0);
	const entry = new Text(text, 0, 0);
	const tail = new Text("tail", 0, 0);
	const document = new VStack([before, entry, tail]);
	const scroll = new ScrollView(document, { primary: true, follow: "end" });
	const copies: string[] = [];
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copies.push(text);
			return true;
		},
	});
	tui.setLayoutRoot(scroll);
	tui.setTranscriptNavigationTargets([{ identity: entry, component: entry }]);
	tui.start();
	const paint = async () => {
		tui.renderNow();
		await terminal.flush();
	};
	await paint();
	const rows = terminal.getViewport();
	const row = rows.findIndex((line) => line.startsWith("START"));
	const end = rows.findLastIndex((line) => line.includes("END"));
	assert.ok(row >= 0 && end >= row);
	terminal.sendInput(`\x1b[<0;1;${row + 1}M`);
	terminal.sendInput(`\x1b[<32;80;${end + 1}M`);
	terminal.sendInput(`\x1b[<0;80;${end + 1}m`);
	await paint();
	assert.equal(copies.length, 0);
	assert.equal(await tui.copyActiveSelectionToClipboard(), true);
	const selected = copies.at(-1)!;
	assert.equal(selected, text);
	return {
		terminal,
		before,
		entry,
		tail,
		document,
		copies,
		tui,
		selected,
		paint,
		dispose: () => {
			tui.stop();
			terminal.dispose();
		},
	};
}

// #35: retain source offsets in the same native component, not obsolete terminal coordinates.
it("maps selection through wrapping, preceding output and semantic navigation without copying", async () => {
	const f = await selectedFixture();
	try {
		for (const width of [20, 40, 80]) {
			const count = f.copies.length;
			f.terminal.resize(width, 40);
			await f.paint();
			assert.equal(f.copies.length, count);
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(f.copies.at(-1), f.selected);
		}
		for (const chunks of [1, 3, 10]) {
			const count = f.copies.length;
			f.tail.setText("streaming tail\n".repeat(chunks));
			await f.paint();
			assert.equal(f.copies.length, count);
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(f.copies.at(-1), f.selected);
		}
		const count = f.copies.length;
		f.before.setText("collapsed prefix");
		await f.paint();
		f.tui.scrollToPreviousTranscriptTarget();
		await f.paint();
		assert.equal(f.copies.length, count);
		assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
		assert.equal(f.copies.at(-1), f.selected);
	} finally {
		f.dispose();
	}
});

// #35: Unicode and hard-wrapped tokens retain their exact source text through narrow reflow.
it("maps wide graphemes, combining marks and hard-wrapped words", async () => {
	const f = await selectedFixture(`START 界面 🚲 e\u0301 ${"longtoken".repeat(15)} END`);
	try {
		for (const width of [20, 40, 80]) {
			f.terminal.resize(width, 40);
			await f.paint();
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(f.copies.at(-1), f.selected);
		}
	} finally {
		f.dispose();
	}
});

// #35: replacing an owner is not a semantic mapping even when its displayed text is identical.
it("clears selection after same-text component replacement", async () => {
	const f = await selectedFixture();
	try {
		f.document.clear();
		f.document.addChild(f.before);
		f.document.addChild(new Text(f.selected, 0, 0));
		f.document.addChild(f.tail);
		await f.paint();
		assert.equal(f.tui.hasActiveSelection(), false);
		assert.equal(f.copies.length, 1);
	} finally {
		f.dispose();
	}
});

// #35: source changes invalidate rather than retaining stale coordinates or finding duplicate text.
it("clears selection when selected component content changes", async () => {
	const f = await selectedFixture();
	try {
		f.entry.setText("REPLACED selected content");
		await f.paint();
		assert.equal(f.tui.hasActiveSelection(), false);
		assert.equal(await f.tui.copyActiveSelectionToClipboard(), false);
		assert.equal(f.copies.length, 1);
	} finally {
		f.dispose();
	}
});
