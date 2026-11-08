import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { ExtensionStartupError } from "../../src/core/extensions/startup-error.ts";
import type { ExtensionContext, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { ModelRouteContext } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});
async function host(options: HarnessOptions = {}) {
	const harness = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }], ...options });
	harnesses.push(harness);
	return harness;
}

// Refs nredd/pi-harness#581: route registrations outlive registrants on a shared ModelRuntime.
it("uses the requester's context and gated registry, not a disposed or fatally failed registrant", async () => {
	const contexts: ModelRouteContext[] = [];
	let captured: ExtensionContext | undefined;
	const router: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			provider: "router",
			id: "owner",
			name: "Owner",
			async route(_request, ctx) {
				contexts.push(ctx);
				const physical = ctx.modelRegistry.find("faux", "physical")!;
				const nested = await ctx.modelRegistry.complete(physical, { messages: [] });
				if (nested.stopReason === "error") throw new Error(nested.errorMessage);
				return { model: physical, thinkingLevel: "off" };
			},
		});
		pi.on("session_start", (_event, ctx) => {
			captured = ctx;
		});
	};
	const parent = await host({ extensionFactories: [router] });
	await parent.session.bindExtensions({ mode: "print" });
	const child = await host({
		modelRuntime: parent.session.modelRuntime,
		fauxProvider: parent.faux,
		extensionFactories: [
			router,
			(pi) => {
				pi.on("session_start", () => {
					throw new ExtensionStartupError("child refuses startup");
				});
			},
		],
	});
	await expect(child.session.bindExtensions({ mode: "print" })).rejects.toThrow("child refuses startup");
	child.session.dispose();
	expect(() => captured?.modelRegistry).toThrow("stale");
	parent.setResponses([fauxAssistantMessage("nested"), fauxAssistantMessage("parent")]);
	const model = parent.session.modelRuntime.getModel("router", "owner")!;
	await parent.session.setModel(model);
	await parent.session.prompt("route parent");
	expect(parent.session.getLastAssistantText()).toBe("parent");
	expect(contexts[0].session?.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
	expect(contexts[0].session?.sessionManager.getSessionId()).not.toBe(child.sessionManager.getSessionId());
	parent.setResponses([fauxAssistantMessage("raw nested")]);
	await parent.session.modelRuntime.resolveModel(model, [], { reason: "direct", thinkingLevel: "off" });
	expect(contexts.at(-1)?.session).toBeUndefined();
});

// Refs nredd/pi-harness#581: nested routing requests must keep the requesting session's startup gate.
it("refuses nested and final provider dispatch while the requester is starting", async () => {
	let nestedError: string | undefined;
	let finalError: string | undefined;
	const parent = await host({
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "gated",
					name: "Gated",
					async route(_request, ctx) {
						const model = ctx.modelRegistry.find("faux", "physical")!;
						nestedError = (await ctx.modelRegistry.complete(model, { messages: [] })).errorMessage;
						return { model, thinkingLevel: "off" };
					},
				});
				pi.on("session_start", async (_event, ctx) => {
					const model = ctx.modelRegistry.find("router", "gated")!;
					finalError = (await ctx.modelRegistry.streamSimple(model, { messages: [] }).result()).errorMessage;
				});
			},
		],
	});
	parent.setResponses([fauxAssistantMessage("must not dispatch")]);
	await parent.session.bindExtensions({ mode: "print" });
	expect(nestedError).toContain("still starting");
	expect(finalError).toContain("still starting");
	expect(parent.getPendingResponseCount()).toBe(1);
});

// Refs nredd/pi-harness#581: genuine replacement is still last-writer-wins, not resurrected on disposal.
it("keeps the replacement definition and requester identity after an unstarted registrant dies", async () => {
	const owner: string[] = [];
	const router =
		(name: string): ExtensionFactory =>
		(pi) =>
			pi.registerVirtualModel({
				provider: "router",
				id: "replacement",
				name,
				route(_request, ctx) {
					owner.push(name);
					return { model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" };
				},
			});
	const parent = await host({ extensionFactories: [router("original")] });
	const child = await host({
		modelRuntime: parent.session.modelRuntime,
		fauxProvider: parent.faux,
		extensionFactories: [router("replacement")],
	});
	child.session.dispose();
	parent.setResponses([fauxAssistantMessage("replacement routed")]);
	await parent.session.setModel(parent.session.modelRuntime.getModel("router", "replacement")!);
	await parent.session.prompt("route");
	expect(owner).toEqual(["replacement"]);
	expect(parent.session.getLastAssistantText()).toBe("replacement routed");
});
