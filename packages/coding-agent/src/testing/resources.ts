/**
 * Resource loading for in-process tests: extensions from factories, no filesystem discovery.
 */

import { createEventBus } from "../core/event-bus.ts";
import type { Extension, ExtensionFactory, InlineExtension, LoadExtensionsResult } from "../core/extensions/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../core/extensions/loader.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";

/** A factory with the path it reports as its source, e.g. a package entry. */
export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

type TestExtensionInput = InlineExtension | CreateTestExtensionsResultInput;

/** Load `inputs` through the real extension loader, sharing one runtime and event bus. */
export async function createTestExtensionsResult(
	inputs: TestExtensionInput[],
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: Extension[] = [];

	for (const [index, input] of inputs.entries()) {
		const isObject = typeof input !== "function";
		const hasName = isObject && "name" in input;
		const hasPath = isObject && "path" in input && typeof input.path === "string" && input.path !== "";
		const factory = isObject ? input.factory : input;
		const extensionPath = hasName ? `<inline:${input.name}>` : hasPath ? input.path : `<inline:${index + 1}>`;

		extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath));
	}

	return {
		extensions,
		errors: [],
		runtime,
	};
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
}

/** A resource loader with the given extensions and no skills, prompts, themes, or context files. */
export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	const extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}
