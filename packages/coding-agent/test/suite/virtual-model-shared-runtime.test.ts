import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ApiProvider, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
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

// Refs nredd/pi-harness#581: a background session shares a ModelRuntime with its parent; sibling
// registrants come and go while it does tool activity, retries and resumes.
it("keeps a child's tool, retry and resume requests routable while siblings dispose and reload", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-581-"));
	dirs.push(root);
	const extPath = join(root, "router.ts");
	writeFileSync(extPath, ROUTER_SOURCE);
	const routes: Array<string | undefined> = [];
	(globalThis as { __routes581?: unknown }).__routes581 = routes;
	try {
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
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const parent = await host({});
		transport = getApiProvider(parent.faux.api);
		const shared = { modelRuntime: parent.session.modelRuntime, fauxProvider: parent.faux };
		const sessionDir = join(root, "sessions");
		const childManager = SessionManager.create(root, sessionDir);
		const child = await host({
			...shared,
			tools: [tool],
			sessionManager: childManager,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		const router = parent.session.modelRuntime.getModel("router", "owner")!;
		await child.session.setModel(router);

		// Tool activity, with a sibling registrant disposed mid-run.
		const sibling = await host(shared);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after tool"),
		]);
		sibling.session.dispose();
		await child.session.prompt("use the tool");
		expect(child.session.getLastAssistantText()).toBe("after tool");

		// Retry after a transient error, with the parent reloading in between.
		await parent.session.reload();
		child.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await child.session.prompt("retry me");
		expect(child.session.getLastAssistantText()).toBe("recovered");

		// Resume from the session file while another sibling is reloaded.
		const file = childManager.getSessionFile()!;
		child.session.dispose();
		const sibling2 = await host(shared);
		await sibling2.session.reload();
		const resumed = await host({ ...shared, sessionManager: SessionManager.open(file, sessionDir) });
		await resumed.session.setModel(router);
		resumed.setResponses([fauxAssistantMessage("resumed")]);
		await resumed.session.prompt("resume");
		expect(resumed.session.getLastAssistantText()).toBe("resumed");

		const stale = [child, resumed].flatMap((h) =>
			h.events.flatMap((e) =>
				e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error"
					? [e.message.errorMessage]
					: [],
			),
		);
		expect(stale.filter((m) => m?.includes("stale"))).toEqual([]);
		expect(routes.length).toBeGreaterThanOrEqual(5);
		expect(routes.filter((id) => id === childManager.getSessionId()).length).toBeGreaterThanOrEqual(4);
		expect(routes.at(-1)).toBe(resumed.sessionManager.getSessionId());
	} finally {
		delete (globalThis as { __routes581?: unknown }).__routes581;
	}
});
