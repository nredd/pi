import { createProvider, fauxAssistantMessage, type ImageModel } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import type { ModelRouteContext } from "../../src/core/virtual-models.ts";
import { createHarness } from "./harness.ts";

// Refs #581: a request-owned registry must not become an escape from requester disposal.
it("refuses nested provider calls through a routing registry after its requester is disposed", async () => {
	let routed: ModelRouteContext | undefined;
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "owner",
					name: "Owner",
					route(_request, ctx) {
						routed = ctx;
						return { model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" };
					},
				});
			},
		],
	});
	try {
		await h.session.setModel(h.session.modelRuntime.getModel("router", "owner")!);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not dispatch")]);
		await h.session.prompt("route");
		const ctx = routed;
		if (!ctx) throw new Error("Route did not receive a context");
		const model = ctx.modelRegistry.find("faux", "physical")!;
		h.session.dispose();
		const result = await ctx.modelRegistry.complete(model, { messages: [] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("disposed");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(() => ctx.appendEntry?.("late", {})).toThrow("stale");
	} finally {
		h.cleanup();
	}
});

// Refs #581: reloading during an asynchronous route must not dispatch its stale result.
it("refuses an in-flight route invalidated by its requester's reload before final dispatch", async () => {
	let entered: () => void = () => {};
	let release: () => void = () => {};
	const routing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let pause = true;
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "owner",
					name: "Owner",
					async route(_request, ctx) {
						const model = ctx.modelRegistry.find("faux", "physical")!;
						if (pause) {
							entered();
							await held;
						}
						return { model, thinkingLevel: "off" };
					},
				});
			},
		],
	});
	try {
		await h.session.setModel(h.session.modelRuntime.getModel("router", "owner")!);
		h.setResponses([fauxAssistantMessage("fresh")]);
		const prompt = h.session.prompt("stale route");
		await routing;
		await h.session.reload();
		release();
		await prompt;
		expect(h.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("stale"),
		});
		expect(h.getPendingResponseCount()).toBe(1);
		pause = false;
		await h.session.prompt("fresh route");
		expect(h.session.getLastAssistantText()).toBe("fresh");
	} finally {
		release();
		h.cleanup();
	}
});

// Refs #581: disposing the requester during an asynchronous route refuses the result, too.
it("refuses an in-flight route whose requester is disposed before final dispatch", async () => {
	let entered: () => void = () => {};
	let release: () => void = () => {};
	const routing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "owner",
					name: "Owner",
					async route(_request, ctx) {
						const model = ctx.modelRegistry.find("faux", "physical")!;
						entered();
						await held;
						return { model, thinkingLevel: "off" };
					},
				});
			},
		],
	});
	try {
		await h.session.setModel(h.session.modelRuntime.getModel("router", "owner")!);
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		const prompt = h.session.prompt("dispose while routing").then(
			() => "completed",
			(error: unknown) => String(error),
		);
		await routing;
		h.session.dispose();
		release();
		await prompt;
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		release();
		h.cleanup();
	}
});

// Refs #581: routing finishing does not make a request survive its requester's reload.
it.each(["virtual", "nested", "physical", "stream", "complete"] as const)(
	"refuses a stable registry's %s request reloaded during physical header preparation",
	async (kind) => {
		let entered = false;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const options = {
			transformHeaders: async (headers: Record<string, string | null>) => {
				entered = true;
				await held;
				return headers;
			},
		};
		const h = await createHarness({
			useModelRuntimeStream: true,
			models: [{ id: "physical" }],
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "owner",
						name: "Owner",
						async route(_request, ctx) {
							const model = ctx.modelRegistry.find("faux", "physical")!;
							if (kind === "nested") {
								const nested = await ctx.modelRegistry.complete(model, { messages: [] }, options);
								if (nested.stopReason === "error") throw new Error(nested.errorMessage);
							}
							return { model, thinkingLevel: "off" };
						},
					});
				},
			],
		});
		try {
			const registry = h.session.extensionRunner.createContext().modelRegistry;
			const virtual = kind === "virtual" || kind === "nested";
			const model = registry.find(virtual ? "router" : "faux", virtual ? "owner" : "physical")!;
			const responses = kind === "nested" ? 2 : 1;
			h.setResponses(Array.from({ length: responses }, () => fauxAssistantMessage("fresh")));
			const result =
				kind === "complete"
					? registry.complete(model, { messages: [] }, options)
					: kind === "stream"
						? registry.stream(model, { messages: [] }, options).result()
						: registry.streamSimple(model, { messages: [] }, options).result();
			await expect.poll(() => entered).toBe(true);
			await h.session.reload();
			release();
			expect(await result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("stale") });
			expect(h.getPendingResponseCount()).toBe(responses);
			expect(await registry.streamSimple(model, { messages: [] }).result()).toMatchObject({ stopReason: "stop" });
			expect(h.getPendingResponseCount()).toBe(0);
		} finally {
			release();
			h.cleanup();
		}
	},
);

// Refs #581: the Models API keeps request generations through deferred preparation, too.
it.each(["streamDeferred", "fetchDeferred", "cancelDeferred"] as const)(
	"refuses stale %s preparation without touching the faux provider",
	async (method) => {
		let entered = false;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
		try {
			const models = h.session.modelRuntime.withBeforeProviderRequest(
				async () => () => {},
				() => {
					const session = h.session.extensionRunner.createContext();
					return { session, modelRegistry: session.modelRegistry };
				},
			);
			// The harness's compatibility registration has no deferred provider methods.
			// Use pi-ai's native faux provider, not a stand-in or an unsupported-method error.
			const faux = fauxProvider({ models: [{ id: "physical" }] });
			h.session.modelRuntime.registerNativeProvider(faux.provider);
			const model = faux.getModel();
			faux.setResponses([fauxAssistantMessage("deferred"), fauxAssistantMessage("fresh")]);
			const initial = await models.completeSimple(model, { messages: [] }, { deferred: true });
			const handle = initial.deferred;
			if (!handle) throw new Error("Faux provider did not return a deferred handle");
			const options = {
				transformHeaders: async (headers: Record<string, string | null>) => {
					entered = true;
					await held;
					return headers;
				},
			};
			const operation =
				method === "streamDeferred"
					? models.streamDeferred(model, handle, options).result()
					: method === "fetchDeferred"
						? models.fetchDeferred(model, handle, options)
						: models.cancelDeferred(model, handle, options);
			const outcome = operation.then(
				(result) => result,
				(error: unknown) => error,
			);
			await expect.poll(() => entered).toBe(true);
			await h.session.reload();
			release();
			if (method === "cancelDeferred") {
				expect(await outcome).toMatchObject({ message: expect.stringContaining("stale") });
			} else {
				expect(await outcome).toMatchObject({
					stopReason: "error",
					errorMessage: expect.stringContaining("stale"),
				});
			}
			expect(faux.state.deferredFetchCount).toBe(0);
			expect(faux.state.cancelledDeferred).toHaveLength(0);
			expect(faux.getPendingResponseCount()).toBe(1);
			expect(await models.fetchDeferred(model, handle)).toMatchObject({ stopReason: "stop" });
			expect(await models.completeSimple(model, { messages: [] })).toMatchObject({ stopReason: "stop" });
			expect(faux.getPendingResponseCount()).toBe(0);
		} finally {
			release();
			h.cleanup();
		}
	},
);

// Refs #581: no await may separate the generation recheck from the physical dispatch.
it("rechecks the captured generation synchronously after the existing final gate", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	try {
		const session = h.session.extensionRunner.createContext();
		const models = h.session.modelRuntime.withBeforeProviderRequest(
			async () => () => h.session.extensionRunner.invalidate(),
			() => ({ session, modelRegistry: session.modelRegistry }),
		);
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		expect(await models.completeSimple(h.getModel(), { messages: [] })).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("stale"),
		});
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		h.cleanup();
	}
});

// Refs #581: image generation shares the same synchronous generation recheck.
it("refuses image generation once its requester is invalidated after the final gate", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	try {
		const generated = vi.fn();
		const model: ImageModel<"test-images"> = {
			type: "image",
			id: "painter",
			name: "Painter",
			api: "test-images",
			provider: "image-owner",
			baseUrl: "https://images.example.invalid/v1",
			input: ["text"],
			output: ["image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		h.session.modelRuntime.registerNativeProvider(
			createProvider({
				id: "image-owner",
				auth: { apiKey: { name: "Key", resolve: async () => ({ auth: {} }) } },
				models: [model],
				images: {
					"test-images": {
						generateImages: async (target) => {
							generated();
							return {
								api: target.api,
								provider: target.provider,
								model: target.id,
								output: [],
								stopReason: "stop",
								timestamp: 0,
							};
						},
					},
				},
			}),
		);
		const session = h.session.extensionRunner.createContext();
		const models = h.session.modelRuntime.withBeforeProviderRequest(
			async () => () => h.session.extensionRunner.invalidate(),
			() => ({ session, modelRegistry: session.modelRegistry }),
		);
		const result = await models.generateImages(model, { input: [{ type: "text", text: "a circle" }] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stale");
		expect(generated).not.toHaveBeenCalled();
	} finally {
		h.cleanup();
	}
});

// Refs #581: registrant and sibling reloads do not invalidate the requester's generation.
it("permits a request paused in physical preparation while an independent sibling reloads", async () => {
	let entered = false;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const sibling = await createHarness({ fauxProvider: h.faux, modelRuntime: h.session.modelRuntime });
	try {
		const registry = h.session.extensionRunner.createContext().modelRegistry;
		h.setResponses([fauxAssistantMessage("independent")]);
		const result = registry
			.streamSimple(
				h.getModel(),
				{ messages: [] },
				{
					transformHeaders: async (headers) => {
						entered = true;
						await held;
						return headers;
					},
				},
			)
			.result();
		await expect.poll(() => entered).toBe(true);
		await sibling.session.reload();
		release();
		expect(await result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "independent" }] });
		expect(h.getPendingResponseCount()).toBe(0);
	} finally {
		release();
		sibling.cleanup();
		h.cleanup();
	}
});

// Refs #581: the agent and every summarizer must retain ownership after routing, too.
it.each(["agent", "summary"] as const)("refuses %s dispatch reloaded during physical authentication", async (kind) => {
	let entered = false;
	let pause = true;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "owner",
					name: "Owner",
					route: (_request, ctx) => ({ model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" }),
				});
			},
		],
	});
	const originalGetAuth = h.session.modelRuntime.getAuth.bind(h.session.modelRuntime);
	const auth = vi.spyOn(h.session.modelRuntime, "getAuth").mockImplementation(async (...args) => {
		if (pause) {
			entered = true;
			await held;
		}
		return originalGetAuth(...args);
	});
	try {
		await h.session.setModel(h.session.modelRuntime.getModel("router", "owner")!);
		h.setResponses([fauxAssistantMessage("fresh")]);
		const result =
			kind === "agent"
				? h.session.prompt("stale")
				: h.session.summarizeForBugReport({ signal: new AbortController().signal });
		// Observe rejection immediately, including if a pre-dispatch guard rejects before our assertion.
		const outcome = result.then(
			() => "completed",
			(error: unknown) => String(error),
		);
		await expect.poll(() => entered).toBe(true);
		await h.session.reload();
		release();
		if (kind === "agent") {
			await outcome;
			expect(h.session.messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("stale"),
			});
		} else {
			expect(await outcome).toContain("stale");
		}
		expect(h.getPendingResponseCount()).toBe(1);
		pause = false;
		if (kind === "agent") {
			await h.session.prompt("fresh");
			expect(h.session.getLastAssistantText()).toBe("fresh");
		} else {
			expect(await h.session.summarizeForBugReport({ signal: new AbortController().signal })).toBe("fresh");
		}
	} finally {
		release();
		auth.mockRestore();
		h.cleanup();
	}
});

// Refs #581: a retained routing registry belongs to that request's runner, not future reloads.
it("refuses retained routing registries after their own requester reloads but permits a fresh request", async () => {
	let routed: ModelRouteContext | undefined;
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		extensionFactories: [
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "owner",
					name: "Owner",
					route(_request, ctx) {
						routed = ctx;
						return { model: ctx.modelRegistry.find("faux", "physical")!, thinkingLevel: "off" };
					},
				});
			},
		],
	});
	try {
		await h.session.setModel(h.session.modelRuntime.getModel("router", "owner")!);
		h.setResponses([fauxAssistantMessage("first")]);
		await h.session.prompt("route");
		const ctx = routed;
		if (!ctx) throw new Error("Route did not receive a context");
		const registry = ctx.modelRegistry;
		const physical = registry.find("faux", "physical")!;
		const virtual = registry.find("router", "owner")!;
		await h.session.reload();
		h.setResponses([fauxAssistantMessage("fresh")]);
		const result = await registry.complete(physical, { messages: [] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stale");
		expect((await registry.streamSimple(virtual, { messages: [] }).result()).stopReason).toBe("error");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(() => ctx.appendEntry?.("late", {})).toThrow("stale");
		await h.session.prompt("fresh route");
		expect(h.session.getLastAssistantText()).toBe("fresh");
		expect(h.getPendingResponseCount()).toBe(0);
	} finally {
		h.cleanup();
	}
});

type ReloadableLoader = { reload(): Promise<void> };

// Refs #581: between invalidating the old runner and building the new one, a fresh request
// through the stable session view must wait for the new runner instead of failing stale.
it("holds a fresh request made during reload until the new runner exists", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const loader = (h.session as unknown as { _resourceLoader: ReloadableLoader })._resourceLoader;
	const reload = loader.reload.bind(loader);
	let entered = false;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(loader, "reload").mockImplementation(async () => {
		entered = true;
		await held;
		await reload();
	});
	try {
		const registry = h.session.extensionRunner.createContext().modelRegistry;
		const model = registry.find("faux", "physical")!;
		h.setResponses([fauxAssistantMessage("fresh")]);
		const reloading = h.session.reload();
		await expect.poll(() => entered).toBe(true);
		const request = registry.complete(model, { messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.getPendingResponseCount()).toBe(1);
		release();
		await reloading;
		expect(await request).toMatchObject({ stopReason: "stop" });
		expect(h.getPendingResponseCount()).toBe(0);
	} finally {
		release();
		h.cleanup();
	}
});

it("does not hang a request held by a reload that fails", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const loader = (h.session as unknown as { _resourceLoader: ReloadableLoader })._resourceLoader;
	let entered = false;
	let fail: () => void = () => {};
	const held = new Promise<void>((_, reject) => {
		fail = () => reject(new Error("reload failed"));
	});
	vi.spyOn(loader, "reload").mockImplementation(async () => {
		entered = true;
		await held;
	});
	try {
		const registry = h.session.extensionRunner.createContext().modelRegistry;
		const model = registry.find("faux", "physical")!;
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		const reloading = h.session.reload().then(
			() => undefined,
			(error: unknown) => error,
		);
		await expect.poll(() => entered).toBe(true);
		const request = registry.complete(model, { messages: [] });
		fail();
		expect(await reloading).toMatchObject({ message: "reload failed" });
		expect(await request).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("stale") });
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		fail();
		h.cleanup();
	}
});

it("rejects a request held by a reload when the session is disposed", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const loader = (h.session as unknown as { _resourceLoader: ReloadableLoader })._resourceLoader;
	const reload = loader.reload.bind(loader);
	let entered = false;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(loader, "reload").mockImplementation(async () => {
		entered = true;
		await held;
		await reload();
	});
	try {
		const registry = h.session.extensionRunner.createContext().modelRegistry;
		const model = registry.find("faux", "physical")!;
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		const reloading = h.session.reload().then(
			() => undefined,
			() => undefined,
		);
		await expect.poll(() => entered).toBe(true);
		const request = registry.complete(model, { messages: [] });
		h.session.dispose();
		release();
		await reloading;
		expect(await request).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("disposed") });
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		release();
		h.cleanup();
	}
});

/** Fails fast instead of hanging if a regression deadlocks the promise. */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3000);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// Refs #581: the reload hold must not span handlers that await requests of their own.
it("does not deadlock reload on a resources_discover handler awaiting a model request", async () => {
	let armed = false;
	let request: Promise<unknown> | undefined;
	const h = await createHarness({
		useModelRuntimeStream: true,
		models: [{ id: "physical" }],
		extensionFactories: [
			(pi) => {
				pi.on("resources_discover", async (_event, ctx) => {
					if (!armed) return;
					const model = ctx.modelRegistry.find("faux", "physical")!;
					request = ctx.modelRegistry.complete(model, { messages: [] });
					await request;
				});
			},
		],
	});
	try {
		await h.session.bindExtensions({ mode: "print" });
		armed = true;
		h.setResponses([fauxAssistantMessage("discovered")]);
		await within(h.session.reload(), "reload");
		expect(await within(request!, "request")).toMatchObject({ stopReason: "stop" });
		expect(h.getPendingResponseCount()).toBe(0);
		await within(h.session.reload(), "second reload");
	} finally {
		h.cleanup();
	}
});

it("fails a request awaited by reload's own resource loading instead of deadlocking", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const loader = (h.session as unknown as { _resourceLoader: ReloadableLoader })._resourceLoader;
	const registry = h.session.extensionRunner.createContext().modelRegistry;
	let outcome: unknown;
	vi.spyOn(loader, "reload").mockImplementation(async () => {
		outcome = await registry.complete(registry.find("faux", "physical")!, { messages: [] });
	});
	try {
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		await within(h.session.reload(), "reload");
		expect(outcome).toMatchObject({ stopReason: "error" });
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		h.cleanup();
	}
});

it("fails a request awaited by beforeSessionStart instead of deadlocking reload", async () => {
	const h = await createHarness({ useModelRuntimeStream: true, models: [{ id: "physical" }] });
	const registry = h.session.extensionRunner.createContext().modelRegistry;
	let outcome: unknown;
	try {
		await h.session.bindExtensions({ mode: "print" });
		h.setResponses([fauxAssistantMessage("must not dispatch")]);
		await within(
			h.session.reload({
				beforeSessionStart: async () => {
					await Promise.resolve();
					outcome = await registry.complete(registry.find("faux", "physical")!, { messages: [] });
				},
			}),
			"reload",
		);
		expect(outcome).toMatchObject({ stopReason: "error" });
		expect(h.getPendingResponseCount()).toBe(1);
	} finally {
		h.cleanup();
	}
});
