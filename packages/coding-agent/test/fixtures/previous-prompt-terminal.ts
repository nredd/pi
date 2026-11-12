/** Isolated native-terminal fixture for nredd/pi#29. Run with the source resolver, never live auth/config. */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { FooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "../../src/testing/harness.ts";

let calls = 0;
const harness = await createHarness({
	settings: {
		quietStartup: true,
		fullscreenScrollbar: "hidden",
		fullscreenCopyOnSelect: false,
		compaction: { enabled: false },
	},
	extensionFactories: [
		(pi) =>
			pi.registerTool(
				createBashToolDefinition("/tmp", {
					operations: {
						exec: async (_command, _cwd, { onData }) => {
							calls++;
							for (let row = 0; row < 40; row++) {
								onData(Buffer.from(`TOOL ${calls} substantial output row ${row}\n`));
								await new Promise((resolve) => setTimeout(resolve, calls === 3 ? 350 : 25));
							}
							return { exitCode: 0 };
						},
					},
				}),
			),
	],
});
for (let turn = 1; turn <= 3; turn++) {
	harness.appendResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: `proof-tool-${turn}` })], { stopReason: "toolUse" }),
		fauxAssistantMessage(
			Array.from({ length: 28 }, (_, row) => `ANSWER ${turn} substantial transcript row ${row}`).join("\n"),
		),
	]);
}
const runtime = new AgentSessionRuntime(
	harness.session,
	{
		cwd: harness.cwd,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	},
	async () => {
		throw new Error("Session replacement is outside this terminal fixture");
	},
);
const mode = new InteractiveMode(runtime, {
	tuiMode: "fullscreen",
	initialThemeSetting: "dark",
	keybindings: new KeybindingsManager({ "app.transcript.previousUserPrompt": "f8" }),
	footerDataProvider: new FooterDataProvider(harness.cwd, null),
	prepareTools: async () => ({}),
	onInput: (text) => {
		void harness.session.prompt(text).catch((error: unknown) => mode.showError(String(error)));
	},
});
process.once("exit", () => harness.cleanup());
await mode.init();
