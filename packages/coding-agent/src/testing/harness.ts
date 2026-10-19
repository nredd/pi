/**
 * In-process harness: a real `AgentSession` around a scripted faux provider.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import { getApiProvider, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { AgentSession, type AgentSessionEvent } from "../core/agent-session.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import type {
	ExtensionRunner,
	ExtensionUIContext,
	InlineExtension,
	SessionStartEvent,
} from "../core/extensions/index.ts";
import { convertToLlm } from "../core/messages.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { SessionManager } from "../core/session-manager.ts";
import type { Settings } from "../core/settings-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "./model-registry.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./resources.ts";

// Reload resets the process-global compat registry. A harness owns its scripted transport.
const fauxTransports = new WeakMap<FauxProviderRegistration, typeof streamSimple>();

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

/** The latest result of `toolName` in the session transcript. */
export function getToolResult(harness: Harness, toolName: string): ToolResultMessage {
	const result = harness.session.messages.findLast(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	if (!result) throw new Error(`No ${toolName} tool result`);
	return result;
}

/** An extension UI context that does nothing, with `overrides` applied. */
export function createTestUiContext(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
		...overrides,
	};
}

export interface HarnessOptions {
	/** Caller-owned faux registration, shared across runtime replacements. Cleanup does not unregister it. */
	fauxProvider?: FauxProviderRegistration;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	/** Reuse a runtime across sessions to test host-level isolation. */
	modelRuntime?: ModelRuntime;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	/** Route agent requests through ModelRuntime rather than the faux provider directly. */
	useModelRuntimeStream?: boolean;
	modelsJson?: Record<string, unknown>;
	/** Session to continue, for example to test a resume. Default: a new in-memory session. */
	sessionManager?: SessionManager;
	/** Startup reason supplied by an enclosing session runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Working directory of the session and its extensions, owned by the caller. Default: `tempDir`. */
	cwd?: string;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	/** The session's working directory: `options.cwd`, else `tempDir`. */
	cwd: string;
	/** Scratch directory the harness creates and `cleanup` removes. */
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const cwd = options.cwd ?? tempDir;
	const fauxProvider: FauxProviderRegistration =
		options.fauxProvider ??
		registerFauxProvider({
			models: options.models,
		});
	if (!options.fauxProvider) fauxProvider.setResponses([]);
	let fauxStream = fauxTransports.get(fauxProvider);
	if (!fauxStream) {
		const provider = getApiProvider(fauxProvider.api);
		if (!provider) throw new Error(`Faux transport missing: ${fauxProvider.api}`);
		fauxStream = (requestModel, context, requestOptions) =>
			provider.streamSimple(requestModel, normalizeContext(context), requestOptions);
		fauxTransports.set(fauxProvider, fauxStream);
	}
	const scriptedStream = fauxStream;
	const stream: typeof streamSimple = (requestModel, context, requestOptions) =>
		requestModel.api === fauxProvider.api && !getApiProvider(requestModel.api)
			? scriptedStream(requestModel, context, requestOptions)
			: streamSimple(requestModel, context, requestOptions);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			streamSimple: stream,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const modelRuntime = options.modelRuntime ?? getModelRuntime(modelRegistry);
	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: options.useModelRuntimeStream
			? (requestModel, context, requestOptions) => modelRuntime.streamSimple(requestModel, context, requestOptions)
			: stream,
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, cwd)
		: undefined;
	const resourceLoader =
		options.resourceLoader ??
		createTestResourceLoader(
			extensionsResult
				? {
						extensionsResult,
						reloadExtensions: () => createTestExtensionsResult(options.extensionFactories ?? [], cwd),
					}
				: undefined,
		);

	const session = new AgentSession({
		agent,
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
		settingsManager,
		cwd,
		modelRuntime,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		usesDefaultTools: options.initialActiveToolNames === undefined,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		cwd,
		tempDir,
		cleanup() {
			session.dispose();
			if (!options.fauxProvider) fauxProvider.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
