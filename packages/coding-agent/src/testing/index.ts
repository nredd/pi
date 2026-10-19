/**
 * `@earendil-works/pi-coding-agent/testing`: drive a real `AgentSession` in-process from a test.
 *
 * `createHarness` builds the session, extension runner, settings, auth, and model registry around a
 * scripted faux provider. Extensions load from factories through the real loader, so a package can
 * test its hooks, tools, and commands without a pi process, a terminal, or credentials. The faux
 * builders are re-exported so tests script responses against the same `pi-ai` instance the harness
 * registered with. The interactive host lives in `/testing/interactive`, which needs pi-tui's
 * optional `@xterm/headless` peer.
 */

export {
	type FauxModelDefinition,
	type FauxProviderRegistration,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
export { registerFauxProvider } from "@earendil-works/pi-ai/compat";
export {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	getToolResult,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";
export {
	type CreateTestExtensionsResultInput,
	type CreateTestResourceLoaderOptions,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./resources.ts";
