import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ApiProvider, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROUTER_SOURCE = `export default function (pi) {
	pi.registerVirtualModel({
		provider: "router",
		id: "owner",
		name: "Owner",
		route(_request, ctx) {
			globalThis.__routes581?.push(ctx.session?.sessionManager.getSessionId());
			return { model: ctx.modelRegistry.find("faux", "physical"), thinkingLevel: "off" };
		},
	});
}
`;

let transport: ApiProvider | undefined;

async function loaderFor(extPath: string, root: string): Promise<DefaultResourceLoader> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		noSkills: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [extPath],
	});
	const trusted = { resolveProjectTrust: async () => true };
	await loader.reload(trusted);
	// AgentSession.reload resets API providers; put the shared faux transport back, as the harness's own loader does.
	const reload = loader.reload.bind(loader);
	loader.reload = async (options) => {
		await reload(options ?? trusted);
		if (transport && !getApiProvider(transport.api)) registerApiProvider(transport, "pi-581-faux");
	};
	return loader;
}

// Refs nredd/pi-harness#581: a background session shares a ModelRuntime with its parent. Each case
// makes a sibling the last registrant of `router/owner` (last-writer-wins), then reloads and
// disposes it *before* the request under test, so the request's route ctx is a stale one.
async function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-581-"));
	dirs.push(root);
	const extPath = join(root, "router.ts");
	writeFileSync(extPath, ROUTER_SOURCE);
	const routes: Array<string | undefined> = [];
	(globalThis as { __routes581?: unknown }).__routes581 = routes;
	const host = async (options: HarnessOptions) => {
		const harness = await createHarness({
			useModelRuntimeStream: true,
			models: [{ id: "physical" }],
			cwd: root,
			resourceLoader: await loaderFor(extPath, root),
			...options,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		return harness;
	};
	const parent = await host({});
	transport = getApiProvider(parent.faux.api);
	const shared = { modelRuntime: parent.session.modelRuntime, fauxProvider: parent.faux };
	const sessionDir = join(root, "sessions");
	const childManager = SessionManager.create(root, sessionDir);
	/** A sibling that registers last, reloads (re-registering), then disposes: its registrant goes stale. */
	const staleSibling = async () => {
		const sibling = await host(shared);
		await sibling.session.reload();
		sibling.session.dispose();
	};
	const tool: AgentTool = {
		name: "noop",
		label: "Noop",
		description: "Noop",
		parameters: Type.Object({}),
		// Disposes a sibling *during* the tool's execute.
		execute: async () => {
			await staleSibling();
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const child = await host({
		...shared,
		tools: [tool],
		sessionManager: childManager,
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
	});
	const router = parent.session.modelRuntime.getModel("router", "owner")!;
	await child.session.setModel(router);
	return { host, shared, sessionDir, childManager, child, router, routes, staleSibling };
}

function staleErrors(...hosts: Harness[]): Array<string | undefined> {
	return hosts
		.flatMap((h) =>
			h.events.flatMap((e) =>
				e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error"
					? [e.message.errorMessage]
					: [],
			),
		)
		.filter((m) => m?.includes("stale"));
}

afterEach(() => {
	delete (globalThis as { __routes581?: unknown }).__routes581;
});

test("routes a child's post-tool request after a sibling is disposed during the tool", async () => {
	const { child, childManager, routes } = await setup();
	child.setResponses([
		fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("after tool"),
	]);
	await child.session.prompt("use the tool");
	expect(child.session.getLastAssistantText()).toBe("after tool");
	expect(staleErrors(child)).toEqual([]);
	expect(routes).toEqual([childManager.getSessionId(), childManager.getSessionId()]);
});

test("routes a child's retry after a sibling goes stale between the failure and the retry", async () => {
	const { child, childManager, routes, staleSibling } = await setup();
	child.setResponses([
		async () => {
			await staleSibling();
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
		},
		fauxAssistantMessage("recovered"),
	]);
	await child.session.prompt("retry me");
	expect(child.session.getLastAssistantText()).toBe("recovered");
	expect(staleErrors(child)).toEqual([]);
	expect(routes).toEqual([childManager.getSessionId(), childManager.getSessionId()]);
});

test("routes a resumed session after a sibling reloads and disposes following its creation", async () => {
	const { host, shared, sessionDir, childManager, child, router, routes, staleSibling } = await setup();
	child.setResponses([fauxAssistantMessage("first")]);
	await child.session.prompt("first");
	const file = childManager.getSessionFile()!;
	child.session.dispose();
	const resumed = await host({ ...shared, sessionManager: SessionManager.open(file, sessionDir) });
	await resumed.session.setModel(router);
	// The resumed session's own registration is no longer the last one by the time it prompts.
	await staleSibling();
	resumed.setResponses([fauxAssistantMessage("resumed")]);
	await resumed.session.prompt("resume");
	expect(resumed.session.getLastAssistantText()).toBe("resumed");
	expect(staleErrors(child, resumed)).toEqual([]);
	expect(routes.at(-1)).toBe(resumed.sessionManager.getSessionId());
});
