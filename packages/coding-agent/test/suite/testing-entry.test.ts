import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import * as testing from "../../src/testing/index.ts";
import { createHarness, fauxAssistantMessage, getAssistantTexts, type Harness } from "../../src/testing/index.ts";

describe("@earendil-works/pi-coding-agent/testing", () => {
	const harnesses: Harness[] = [];
	const owned: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (owned.length > 0) rmSync(owned.pop()!, { recursive: true, force: true });
	});

	it("exports the harness, its helpers, and the faux builders", () => {
		expect(Object.keys(testing).sort()).toEqual([
			"createHarness",
			"createInteractiveHarness",
			"createTestExtensionsResult",
			"createTestResourceLoader",
			"createTestUiContext",
			"fauxAssistantMessage",
			"fauxText",
			"fauxThinking",
			"fauxToolCall",
			"getAssistantTexts",
			"getMessageText",
			"getToolResult",
			"getUserTexts",
			"registerFauxProvider",
		]);
	});

	it("runs the session and its extensions in a caller-owned cwd that cleanup keeps", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-harness-cwd-"));
		owned.push(cwd);
		const seen: string[] = [];
		const extension = (pi: ExtensionAPI) => {
			pi.on("session_start", (_event, ctx) => {
				seen.push(ctx.cwd);
			});
		};
		const first = await createHarness({ cwd, extensionFactories: [extension] });
		const second = await createHarness({ cwd, extensionFactories: [extension] });
		harnesses.push(first, second);

		await first.session.bindExtensions({ mode: "print" });
		await second.session.bindExtensions({ mode: "print" });
		first.setResponses([fauxAssistantMessage("one")]);
		await first.session.prompt("hi");

		expect([first.cwd, second.cwd]).toEqual([cwd, cwd]);
		expect(seen).toEqual([cwd, cwd]);
		expect(getAssistantTexts(first)).toEqual(["one"]);
		expect(getAssistantTexts(second)).toEqual([]);

		first.cleanup();
		harnesses.splice(harnesses.indexOf(first), 1);
		expect(existsSync(first.tempDir)).toBe(false);
		expect(existsSync(cwd)).toBe(true);
	});

	it("defaults the cwd to its own scratch directory", async () => {
		let seen: string | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_start", (_event, ctx) => {
						seen = ctx.cwd;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		expect(harness.cwd).toBe(harness.tempDir);
		expect(seen).toBe(harness.tempDir);
	});
});
