import { getApiProvider, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts } from "../src/testing/harness.ts";
import { fauxAssistantMessage } from "../src/testing/index.ts";

// nredd/pi#5: reload must restore the transport without changing auth or registration ownership.
describe("testing harness transport lifecycle", () => {
	for (const withConfiguredAuth of [true, false]) {
		it(`restores and cleans up an owned registration (auth: ${withConfiguredAuth})`, async () => {
			const harness = await createHarness({ withConfiguredAuth });
			try {
				expect(harness.session.agent.streamFunction).toBe(streamSimple);
				for (const reply of ["first reload", "second reload"]) {
					await harness.session.reload();
					expect(getApiProvider(harness.faux.api)).toBeDefined();
					if (withConfiguredAuth) {
						harness.setResponses([fauxAssistantMessage(reply)]);
						await harness.session.prompt("continue");
						expect(getAssistantTexts(harness)).toContain(reply);
					}
				}
			} finally {
				harness.cleanup();
			}
			expect(getApiProvider(harness.faux.api)).toBeUndefined();
		});
	}

	it("keeps a caller-owned restored registration until its owner unregisters it", async () => {
		const faux = registerFauxProvider();
		const first = await createHarness({ fauxProvider: faux });
		try {
			await first.session.reload();
			const replacement = await createHarness({ fauxProvider: faux });
			try {
				first.cleanup();
				expect(getApiProvider(faux.api)).toBeDefined();
				await replacement.session.reload();
				faux.setResponses([fauxAssistantMessage("shared transport")]);
				await replacement.session.prompt("continue");
				expect(getAssistantTexts(replacement)).toContain("shared transport");
			} finally {
				replacement.cleanup();
			}
			expect(getApiProvider(faux.api)).toBeDefined();
		} finally {
			first.cleanup();
			faux.unregister();
		}
		expect(getApiProvider(faux.api)).toBeUndefined();
	});
});
