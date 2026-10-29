# SDK

`@earendil-works/pi-coding-agent` embeds Pi in a Node.js or Bun process. It provides direct TypeScript access to the agent, sessions, tools, models, and resources used by the command-line application.

Use the SDK for in-process TypeScript integration. For a language-independent or isolated subprocess, see [CLI Integration](cli-integration.md).

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

This uses the working directory, discovered resources, stored settings, and configured credentials. `prompt()` resolves when the run finishes.

The [complete minimal example](../examples/sdk/01-minimal.ts) also streams text events. All [SDK examples](../examples/sdk/) are typechecked with the repository.

<a id="session-management"></a>

## Session lifecycle

`createAgentSession()` creates an `AgentSession`. The session owns one conversation, its model and tools, queued messages, compaction state, and extension runtime.

Read current state through `session.messages`, `session.model`, `session.thinkingLevel`, `session.systemPrompt`, and `session.getActiveToolNames()`.

`session.systemPrompt` is read-only and returns the current effective system prompt, including changes that have not yet been sent to the model. Tool changes are declared to the model before the next request.

<a id="sessionmanager-api"></a>

### Session storage

Sessions are persistent by default. `SessionManager` owns the persisted or in-memory entry tree and tracks its active leaf. Branching changes that leaf without deleting abandoned branches. When Pi reconstructs model context, the manager selects the active branch and applies compaction.

`SessionManager` is authoritative for finalized model context. Restore external history by constructing the session with a manager containing those entries. Assigning `session.agent.state.messages` does not replace persisted context.

Use an in-memory manager when the host does not want session files:

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

See the checked [sessions example](../examples/sdk/11-sessions.ts) for creating, opening, continuing, listing, and forking sessions. [Session File Format](session-format.md) defines the persisted JSONL contract, and [Message Types](message-types.md) defines transcript values. For exact methods and signatures, use the exported TypeScript declarations or [`session-manager.ts`](../src/core/session-manager.ts).

`cwd` selects the workspace used for project resource discovery, context files, session grouping, and built-in tool paths. Pass it explicitly when the target differs from `process.cwd()`.

`session.dispose()` aborts active work, invalidates extension contexts, disconnects from the agent, and removes event listeners. Call it when the session is no longer needed.

`AgentSessionRuntime` adds `newSession()`, `switchSession()`, `fork()`, and `importFromJsonl()`. Each operation replaces the active `AgentSession` and recreates services for the target working directory.

After a runtime replacement, subscriptions belong to the old `AgentSession` and must be rebound. See the [session runtime example](../examples/sdk/13-session-runtime.ts).

## Prompting

`prompt()` handles extension commands and expands file-based prompt templates before ordinary user messages enter the agent. For an accepted agent run, it resolves after the run finishes, including automatic retries.

A prompt sent while the session is already streaming must specify whether it should steer the current run or follow it. Calling `prompt()` without that choice rejects rather than guessing.

A steering message enters after the current assistant turn and its tool calls. A follow-up enters after the current run finishes its pending work. `steer()` and `followUp()` expose those behaviors directly and return `"queued"` if the input was queued (including after an extension transformed it), or `"handled"` if an extension consumed it.

`abort()` stops the active operation and waits for the session to become idle. `waitForIdle()` waits without aborting it.

## Subscribing to events

Subscribe before prompting when the host needs streamed output:

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
}
```

Session events report message updates, tool execution, queues, compaction, retries, and run lifecycle changes.

`message_end` contains the authoritative completed message. `agent_end` marks the end of one low-level agent run, but automatic recovery or queued work can still follow.

Use `agent_settled` when the host needs to know that Pi will not continue automatically.

## Configuring a session

Without overrides, the factory creates a `ModelRuntime`, file-backed `SettingsManager`, persistent `SessionManager`, `DefaultResourceLoader`, and the configured default tools.

Each boundary can be supplied explicitly:

- `modelRuntime`, `model`, `thinkingLevel`, and `scopedModels` control model access and selection.
- `settingsManager` supplies merged settings or an in-memory configuration.
- `sessionManager` supplies persistent or in-memory conversation history.
- `resourceLoader` supplies extensions, skills, prompt templates, themes, and context files.
- `tools`, `noTools`, `excludeTools`, and `customTools` control the active tool set.

Use `DefaultResourceLoader` when you want standard discovery with selected overrides. Supply a custom `ResourceLoader` when the host owns resource storage and discovery completely.

Pass an absolute `homeDir` to `DefaultResourceLoader` or `DefaultPackageManager` to select a per-instance resource home without changing `process.env.HOME`:

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd: "/work/project",
  agentDir: "/work/private-home/.pi/agent",
  homeDir: "/work/private-home",
});
await resourceLoader.reload();
const { session } = await createAgentSession({ resourceLoader });
```

This redirects `~` in `cwd`, `agentDir`, configured local packages/resources, additional resource paths and `extendResources()` paths, plus automatic `~/.agents/skills` discovery. `agentDir` still selects Pi's user settings and resource directories independently; `homeDir` does not derive or replace it. `createAgentSessionServices({ resourceLoaderOptions: { homeDir } })` also forwards the option. `PackageManagerOptions` and `DefaultResourceLoaderOptions` are exported for typed hosts.

Omitting `homeDir` retains existing defaults, including the package manager's `HOME || os.homedir()` behavior. Project trust, filters, precedence, ancestor discovery and symlink handling are unchanged. This is a discovery dependency, not a filesystem sandbox: absolute paths, project ancestors, symlink targets, extension code, credentials, package-manager subprocesses and their global installation fallback remain outside its boundary. An explicit `systemPrompt` or `appendSystemPrompt` is still literal text or a path as supplied, not a tilde-expanded resource path. Hosts seeking isolation must also supply private `cwd`, `agentDir`, settings, credentials and session storage as appropriate.

<a id="inlineextension"></a>

Inline extension factories can be supplied through `DefaultResourceLoader`. Give one an `InlineExtension` name only when it needs a stable name in diagnostics and startup output. A named inline extension with `replaceable: true` is left out when another extension registers a tool, command, or flag with a name it registers during loading, instead of both loading with a conflict. The CLI's built-in codemode, tool search, and MCP extensions are replaceable. A named entry with `builtin: true` is not an inline extension: it supplies the code of the `builtin:<name>` extension, which loads like a configured extension file. It loads by default, is listed in `pi config`, and is disabled by `-builtin:<name>` in the `extensions` setting or by `noExtensions`; `additionalExtensionPaths: ["builtin:<name>"]` loads it explicitly. It loads after project trust is resolved, so it cannot handle `project_trust`. The CLI's built-in extensions use it.

<a id="codemode-mcp"></a>

The CLI loads `codemode`, `tool_search`, and MCP as built-in extensions. SDK sessions do not; add `createCodemodeExtension()`, `createToolSearchExtension()`, and `createMcpExtension()` to the `extensionFactories` of `DefaultResourceLoader`. `codemode` and `tool_search` are registered inactive: enable them through the `defaultTools` setting (`["+codemode", "+tool_search"]` keeps the other default tools), or let the MCP extension activate them: `codemode` for servers with `codemode` exposure, `tool_search` for servers with `deferred` exposure. The MCP extension connects its servers on `session_start`, so call `session.bindExtensions()`. See [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts).

A `session_start` handler can fail startup by throwing `ExtensionStartupError`. `bindExtensions()` (and `reload()`) then reject, and the session refuses `prompt()` and other provider-bound calls until a later `bindExtensions()` or `reload()` succeeds. `dispose()` the session if you give up. See [Fail startup on purpose](extensions.md#fatal-startup).

See the focused examples for [models](../examples/sdk/02-custom-model.ts), [tools](../examples/sdk/05-tools.ts), [extensions](../examples/sdk/06-extensions.ts), and [full control](../examples/sdk/12-full-control.ts).

<a id="testing"></a>

## Testing extensions in-process

`@earendil-works/pi-coding-agent/testing` runs a real `AgentSession` in the test process. `createHarness()` builds the session, extension runner, in-memory settings and auth, and a model registry around a scripted faux provider. Extension factories load through the real loader, so hooks, tools, commands, settlement, compaction and resume behave as they do in Pi, without a Pi process, a terminal, credentials, or network.

```typescript
import { createHarness, fauxAssistantMessage, fauxToolCall, getToolResult } from "@earendil-works/pi-coding-agent/testing";
import myExtension from "../src/index.ts";

const harness = await createHarness({ extensionFactories: [myExtension] });
try {
  await harness.session.bindExtensions({ mode: "print" });
  harness.setResponses([
    fauxAssistantMessage([fauxToolCall("my_tool", { path: "a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await harness.session.prompt("use my_tool");
  console.log(getToolResult(harness, "my_tool").content);
} finally {
  harness.cleanup();
}
```

- Creating a harness loads extensions but does not start them. Call `session.bindExtensions()` with the mode under test (`print`, `json`, `rpc`, or `tui`) and a UI context from `createTestUiContext()` when handlers need one; `session_start` runs then.
- `setResponses()`/`appendResponses()` script the faux provider with assistant messages (text, thinking, tool calls, error stop reasons, usage) or functions of the request context. `harness.events` records every session event, and `eventsOfType()` filters them.
- Pass `extensionFactories` with several factories to test how extensions interact, `sessionManager` (for example `SessionManager.open(file)`) to test a resume, and `cwd` to run in a fixture directory. `cleanup()` disposes the session and removes `harness.tempDir`, never a caller-owned `cwd`.
- Import the faux builders from this entry rather than a separate `@earendil-works/pi-ai` copy, so responses are scripted against the instance the harness registered with.
- `createHarness()` bypasses the TUI. Use `createInteractiveHarness()` below for real interactive rendering. CLI argument parsing, package installation/discovery, project trust, and process exit still require boundary tests.

### Testing interactive extensions

`@earendil-works/pi-coding-agent/testing/interactive` is a separate entry because it needs `@xterm/headless@5.5.0`, the optional peer of `@earendil-works/pi-tui`: install it as a dev dependency. `/testing` never loads it. The entry mounts the real `InteractiveMode`, extension UI context, editor, widgets, footer, overlays and transcript on an `AgentSessionRuntime`:

```typescript
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { createInteractiveHarness } from "@earendil-works/pi-coding-agent/testing/interactive";

const host = await createInteractiveHarness({
  extensionFactories: [myExtension],
  columns: 120,
  rows: 40,
  tuiMode: "fullscreen", // or "regular"
  settings: { hideThinkingBlock: true },
});
try {
  host.harness.setResponses([fauxAssistantMessage("hello")]);
  await host.harness.session.prompt("paint a response");
  await host.settle();
  console.log(host.viewport());
  host.input("/reload");
  host.input("\r");
  await host.settle();
  host.resize(80, 24);
  await host.settle();
} finally {
  await host.dispose();
}
```

- Options extend `HarnessOptions`, adding `columns`, `rows`, `tuiMode`, an optional caller-owned `terminal: VirtualTerminal`, and a static `gitBranch` (default `null`). Without an injected terminal, the host owns/disposes its emulator.
- `input(data)` injects raw input, including SGR mouse sequences. `resize(columns, rows)` takes the real resize path. `viewport()` returns visible rows with trailing spaces trimmed; `terminal.getStyledLine(row)` exposes bold and foreground attributes. See [pi-tui testing](../../tui/README.md#testing-in-process).
- `settle(): Promise<void>` awaits editor handlers submitted before the call, including asynchronous built-in commands such as `/new` and `/reload`, then flushes requested frames and fences xterm writes. It does not advance time or await ordinary agent turns and extension commands dispatched through `onInput`, so their held tools and custom overlays remain inspectable. Built-in commands that await user interaction must be completed before awaiting `settle()`. Await `session.prompt()` (or an explicit tool/provider barrier) for turn completion. Inject your extension's clock, advance its callbacks, then call `settle()`; do not replace the emulator's global timers.
- `/reload` retains the session and re-runs factory inputs once through resource-loader reload. `/new` replaces `host.harness`; read it again after settling. The new session uses the same scripted transport and extension factories. The default resource loader restores the faux API registration after reload resets the compat registry, without replacing the agent's default `streamSimple` or bypassing required auth. A supplied `resourceLoader` owns its own reload behavior. `fauxProvider` optionally shares a caller-owned registration across plain harnesses too; their `cleanup()` does not unregister it. The harness extends that registration's `unregister()` method so the owner also removes any restored API registration.
- Startup uses `init()`, not the process-level `run()` loop: no catalog refresh, version/package checks or tmux checks. Managed-tool setup is injected as a no-op (no fd/rg discovery/download), keybindings are in-memory, and footer git data is static (no discovery/watcher). The built-in dark theme avoids custom-theme discovery/watchers; the virtual terminal completes DA1 queries in a microtask without a timeout wait. ANSI styling is enabled and the prior Chalk level/keybindings are restored on disposal.
- Interactive theme/keybinding state is process-global, as in the real app. Keep interactive tests serial within one process; dispose each host before creating the next. Tests run on Node/Vitest and Bun without runner-specific fake timers.

The installed-package gate renders an interactive frame from packed bytes. `npm run check:package-install -- --sdk-only` skips its CLI version checks for environments where launching Pi is forbidden; the default keeps those checks.

## Examples

| Example | Purpose |
|---|---|
| [Minimal](../examples/sdk/01-minimal.ts) | Create, prompt, observe, and dispose a session |
| [Custom model](../examples/sdk/02-custom-model.ts) | Select a model and thinking level |
| [System prompt](../examples/sdk/03-custom-prompt.ts) | Replace or append to the system prompt |
| [Skills](../examples/sdk/04-skills.ts) | Discover, filter, and add skills |
| [Tools](../examples/sdk/05-tools.ts) | Select built-in tools and their working directory |
| [Extensions](../examples/sdk/06-extensions.ts) | Load file-based and inline extensions |
| [Context files](../examples/sdk/07-context-files.ts) | Add or replace project instructions |
| [Prompt templates](../examples/sdk/08-prompt-templates.ts) | Add file-style prompt templates |
| [Credentials](../examples/sdk/09-api-keys-and-oauth.ts) | Configure credential and model storage |
| [Settings](../examples/sdk/10-settings.ts) | Supply file-backed or in-memory settings |
| [Sessions](../examples/sdk/11-sessions.ts) | Control session persistence and restoration |
| [Full control](../examples/sdk/12-full-control.ts) | Replace default discovery and state services |
| [Session runtime](../examples/sdk/13-session-runtime.ts) | Replace the active session safely |
| [Codemode and MCP](../examples/sdk/14-codemode-mcp.ts) | Add the `codemode`, `tool_search`, and MCP extensions |

<a id="exports"></a>

## Resources

- [Choose a Model](models.md) covers model selection and compatible endpoints; [Providers](providers.md) covers credentials and provider-specific setup.
- [Configuration](configuration.md) explains normal discovery and settings; [Settings](settings.md) lists every setting.
- [Sessions and Context](sessions.md) explains session behavior; [Session Format](session-format.md) defines persisted entries; [Message Types](message-types.md) defines shared transcript values.
- [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) document resources supplied through a `ResourceLoader`.
- [CLI Integration](cli-integration.md) covers print, JSON, and RPC alternatives to an in-process SDK integration.
