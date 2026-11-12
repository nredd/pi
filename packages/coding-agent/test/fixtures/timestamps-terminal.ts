/** Offline source-CLI fixture for nredd/pi#30. No provider requests or shell commands leave this process. */
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function timestampsTerminal(pi: ExtensionAPI): void {
	const faux = createFauxCore({ provider: "timestamp-proof", tokensPerSecond: 30 });
	const model = faux.models[0];
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxThinking("Inspect the timestamp framing. Keep the recorded instant."),
				fauxText("STREAMING INTRO\n\nhttps://example.com/one/long/path/that/wraps/without/changing/the/copied/url"),
				fauxToolCall("bash", { command: "fixture-output" }),
			],
			{ timestamp: Date.parse("2020-01-02T03:04:05Z"), stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			"PROOF DONE\n\n日本語 👀\n\n" +
				Array.from({ length: 24 }, (_, index) => `line ${index + 1}: stable recorded transcript content`).join(
					"\n",
				),
			{ timestamp: Date.parse("2020-01-02T03:04:15Z") },
		),
		fauxAssistantMessage("SECOND TURN DONE", { timestamp: Date.parse("2020-01-02T03:05:00Z") }),
	]);
	pi.registerProvider("timestamp-proof", {
		api: faux.api,
		baseUrl: model.baseUrl,
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: model.id,
				name: "Isolated timestamp fixture",
				reasoning: true,
				input: ["text"],
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
	pi.registerTool(
		createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("one\ntwo\n"));
					await new Promise((resolve) => setTimeout(resolve, 1200));
					onData(Buffer.from("three\n"));
					return { exitCode: 0 };
				},
			},
		}),
	);
}
