import { type Api, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const apiModel: Model<Api> = {
	id: "m",
	name: "M",
	api: "openai-completions",
	provider: "late",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

async function createRuntime() {
	const credentials = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	return { credentials, runtime };
}

/** Hold the next availability pass after it listed credentials, i.e. after it snapshotted providers. */
function holdNextPass(credentials: AuthStorage) {
	const list = credentials.list.bind(credentials);
	const listed = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	vi.spyOn(credentials, "list").mockImplementationOnce(async (options) => {
		listed.resolve();
		await held.promise;
		return list(options);
	});
	return { listed: listed.promise, release: () => held.resolve() };
}

/** Make the registration's own refresh wait for the older pass, so only the provisional mark protects it. */
function delayNextRefreshUntil(runtime: ModelRuntime, stale: Promise<unknown>) {
	const refresh = runtime.refresh.bind(runtime);
	vi.spyOn(runtime, "refresh").mockImplementationOnce(async (options) => {
		await stale;
		return refresh(options);
	});
}

describe("ModelRuntime availability passes", () => {
	// #101
	it("keeps a provider registered with registerProvider while an older pass is in flight", async () => {
		const { credentials, runtime } = await createRuntime();
		const pass = holdNextPass(credentials);
		const stale = runtime.refresh({ allowNetwork: false });
		await pass.listed;
		delayNextRefreshUntil(runtime, stale);

		runtime.registerProvider("late", {
			baseUrl: "https://example.test/v1",
			apiKey: "literal-key",
			api: "openai-completions",
			models: [apiModel],
		});
		pass.release();
		await stale;

		expect(runtime.hasConfiguredAuth("late")).toBe(true);
	});

	// #101
	it("keeps a provider registered with registerNativeProvider while an older pass is in flight", async () => {
		// A native provider is provisionally configured when the earlier pass saw a stored credential for it.
		const faux = fauxProvider({ models: [{ id: "small", contextWindow: 1000, maxTokens: 100, input: ["text"] }] });
		const credentials = AuthStorage.inMemory({ [faux.provider.id]: { type: "api_key", key: "stored-key" } });
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		expect(runtime.hasConfiguredAuth(faux.provider.id)).toBe(false);
		const pass = holdNextPass(credentials);
		const stale = runtime.refresh({ allowNetwork: false });
		await pass.listed;
		delayNextRefreshUntil(runtime, stale);

		runtime.registerNativeProvider(faux.provider);
		pass.release();
		await stale;

		expect(runtime.hasConfiguredAuth(faux.provider.id)).toBe(true);
	});

	// nredd/pi#101: an awaited refresh must not resolve while a newer pass that supersedes it is pending
	it("makes an awaited refresh wait for a newer pass that supersedes it", async () => {
		const { credentials, runtime } = await createRuntime();
		const list = credentials.list.bind(credentials);
		const newerListed = Promise.withResolvers<void>();
		const newerHeld = Promise.withResolvers<void>();
		let calls = 0;
		vi.spyOn(credentials, "list").mockImplementation(async (options) => {
			// First pass (the awaited one) lists immediately; the newer one is held.
			if (++calls === 2) {
				newerListed.resolve();
				await newerHeld.promise;
			}
			return list(options);
		});

		const events: string[] = [];
		const awaited = runtime.refresh({ allowNetwork: false }).then(() => events.push("awaited"));
		const newer = runtime.refresh({ allowNetwork: false }).then(() => events.push("newer"));
		await newerListed.promise;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(events).toEqual([]);

		newerHeld.resolve();
		await Promise.all([awaited, newer]);
		expect(events).toEqual(["newer", "awaited"]);
	});

	// nredd/pi#101: waiting on newer passes is bounded and a failing newer pass does not fail the awaited one
	it("does not reject an awaited refresh when the newer pass fails", async () => {
		const { credentials, runtime } = await createRuntime();
		const list = credentials.list.bind(credentials);
		let calls = 0;
		vi.spyOn(credentials, "list").mockImplementation(async (options) => {
			if (++calls === 2) throw new Error("boom");
			return list(options);
		});

		const awaited = runtime.refresh({ allowNetwork: false });
		const newer = runtime.refresh({ allowNetwork: false });
		await expect(Promise.all([awaited, newer])).resolves.toBeDefined();
	});
});
