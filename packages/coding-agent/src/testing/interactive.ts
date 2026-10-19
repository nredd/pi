/** Real interactive mode bound to a scripted session, without a process-level run loop. */
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import type { VirtualTerminal } from "@earendil-works/pi-tui/testing";
import chalk from "chalk";
import { AgentSessionRuntime, type AgentSessionServices } from "../core/agent-session-runtime.ts";
import { FooterDataProvider } from "../core/footer-data-provider.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { InteractiveMode } from "../modes/interactive/interactive-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export interface InteractiveHarnessOptions extends HarnessOptions {
	columns?: number;
	rows?: number;
	tuiMode?: "regular" | "fullscreen";
	/** Inject a caller-owned emulator. Otherwise the harness owns and disposes one. */
	terminal?: VirtualTerminal;
	/** Static branch for footer fixtures; null (default) disables git discovery/watchers. */
	gitBranch?: string | null;
}

export interface InteractiveHarness {
	/** Current harness, replaced by /new. Read again after session replacement. */
	readonly harness: Harness;
	readonly terminal: VirtualTerminal;
	input(data: string): void;
	resize(columns: number, rows: number): void;
	/** Drain queued work and paint requested frames. Does not await held tools or overlays. */
	settle(): Promise<void>;
	viewport(): string[];
	dispose(): Promise<void>;
}

/**
 * Mount the real InteractiveMode UI context on an isolated harness runtime.
 * Uses init(), not run(): no catalog/version/package checks or process input loop.
 * The built-in dark theme avoids custom-theme discovery and filesystem watchers.
 */
export async function createInteractiveHarness(options: InteractiveHarnessOptions = {}): Promise<InteractiveHarness> {
	const previousKeybindings = getKeybindings();
	const previousColorLevel = chalk.level;
	const terminal =
		options.terminal ??
		new (await import("@earendil-works/pi-tui/testing")).VirtualTerminal(options.columns, options.rows);
	const first = await createHarness({ ...options, settings: { quietStartup: true, ...options.settings } });
	chalk.level = 3;
	const harnesses = [first];
	let current = first;
	const services = (harness: Harness): AgentSessionServices => ({
		cwd: harness.cwd,
		agentDir: first.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	});
	const runtime = new AgentSessionRuntime(first.session, services(first), async (target) => {
		current = await createHarness({
			...options,
			settings: current.settingsManager.getGlobalSettings(),
			cwd: target.cwd,
			sessionManager: target.sessionManager,
			sessionStartEvent: target.sessionStartEvent,
			fauxProvider: first.faux,
		});
		harnesses.push(current);
		return {
			session: current.session,
			services: services(current),
			diagnostics: [],
			extensionsResult: current.session.resourceLoader.getExtensions(),
		};
	});
	const errors: unknown[] = [];
	const mode = new InteractiveMode(runtime, {
		terminal,
		tuiMode: options.tuiMode ?? "fullscreen",
		initialThemeSetting: "dark",
		keybindings: new KeybindingsManager(),
		footerDataProvider: new FooterDataProvider(first.cwd, options.gitBranch ?? null),
		prepareTools: async () => ({}),
		onInput: (text) => {
			void runtime.session.prompt(text).catch((error: unknown) => errors.push(error));
		},
	});
	let disposed = false;
	const host: InteractiveHarness = {
		get harness() {
			return current;
		},
		terminal,
		input: (data) => terminal.sendInput(data),
		resize: (columns, rows) => terminal.resize(columns, rows),
		async settle() {
			// nextTick drains the preceding promise jobs too. xterm's callback fences all writes,
			// including frames requested by work that completed while the first batch was parsed.
			await new Promise<void>((resolve) => process.nextTick(resolve));
			mode.flushRender();
			await terminal.flush();
			await new Promise<void>((resolve) => process.nextTick(resolve));
			mode.flushRender();
			await terminal.flush();
			if (errors.length) throw errors.shift();
		},
		viewport: () => terminal.getViewport().map((line) => line.trimEnd()),
		async dispose() {
			if (disposed) return;
			disposed = true;
			try {
				await runtime.session.abort();
				await runtime.dispose();
			} finally {
				mode.stop();
				await terminal.flush();
				if (!options.terminal) terminal.dispose();
				for (const harness of harnesses.toReversed()) harness.cleanup();
				setKeybindings(previousKeybindings);
				chalk.level = previousColorLevel;
			}
		},
	};
	try {
		await mode.init();
		await host.settle();
		return host;
	} catch (error) {
		await host.dispose();
		throw error;
	}
}
