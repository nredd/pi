# Extensions

Extensions are TypeScript modules that add executable behavior to Pi. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone.

An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

Typical extensions add an agent tool, protect paths, confirm dangerous commands, react to session events, modify context, expose a command, or display persistent status.

<a id="quick-start"></a>
<a id="writing-an-extension"></a>
<a id="create-an-extension"></a>

## Create and load an extension

An extension exports a default factory that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime.

Create `~/.pi/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Start Pi and run `/hello`. During development, load a file directly:

```bash
pi --extension ./hello.ts
```

Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step. Use [Pi packages](packages.md) for distributed extensions and dependencies.

<a id="extension-locations"></a>
<a id="available-imports"></a>
<a id="choose-where-it-loads"></a>

## Add it to Pi

Place the extension in your user or project extensions directory. Pi loads direct TypeScript or JavaScript files and subdirectories containing an `index.ts` or `index.js` entry point.

Use a single file for a small extension and a directory for a multi-file implementation. Put npm dependencies in a nearby `package.json`. See [Configuration](configuration.md) for conventional locations and [Settings](settings.md#resources) for additional paths.

Reload replaces the extension runtime, so code after `await ctx.reload()` must not reuse state from the old runtime. Only personal and explicit command-line extensions can participate in the `project_trust` event that runs before project extensions load.

<a id="understand-the-lifecycle"></a>

## Respect the runtime lifecycle

The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, allowing it to fetch configuration or register providers needed during startup.

Do not start processes, sockets, watchers, or timers in the factory because some invocations load extensions without starting a session.
Start long-lived resources from `session_start` or from the command or tool that needs them.
Close session-scoped resources from an idempotent `session_shutdown` handler.

A run proceeds from input and `before_agent_start`, through model, message, and tool events, to `agent_end`.
Pi counts as busy while a run starts, including the compaction check and `before_agent_start`, so messages sent meanwhile go into the starting run.
Automatic retries, recovery, compaction, or queued work can continue afterward.
<a id="agent_start--agent_end--agent_before_settle--agent_settled"></a>

`agent_before_settle` is the final actionable boundary: it can append entries and request one continuation.
`agent_settled` is final and notification-only; use it when an integration needs to know Pi will not continue automatically.

<a id="extensionapi-methods"></a>

## Choose an integration point

| Capability | Main API |
|---|---|
| Observe or modify lifecycle behavior | `pi.on()` |
| Add a model-callable operation | `pi.registerTool()` |
| Add a `/` command | `pi.registerCommand()` |
| Add a shortcut or CLI flag | `pi.registerShortcut()` or `pi.registerFlag()` |
| Send user or custom messages | `pi.sendUserMessage()` or `pi.sendMessage()` |
| Persist non-context session data | `pi.appendEntry()` |
| Change active tools, model, or thinking level | Session control methods on `pi` |
| Add a model provider | `pi.registerProvider()` |
| Add an MCP server | `pi.registerMcpServer()` |
| Route each request to a model | [`pi.registerVirtualModel()`](virtual-models.md) |
| Add terminal rendering | Renderer registration and `ctx.ui` |
| Communicate with another extension | `pi.events` |

Use the exported declarations in [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for exact event, context, tool, and result types.

## Follow the extension contracts

<a id="events"></a>
<a id="work-with-events"></a>

### Events and concurrency

Handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress.
Some events notify; others transform data, replace results, or cancel an operation.
Use each event’s declared result type rather than assuming every return value has an effect.

Events cover resource discovery, sessions, agent and message lifecycle, providers, tools, and raw input.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. `event.messageType` says what started the run: `"user"` for a prompt or `pi.sendUserMessage()`, with `prompt` and `images`; `"custom"` for `pi.sendMessage(..., { triggerTurn: true })`, with the starting `message` and no `prompt`. A returned `message` is added to either kind of run; check `messageType` to skip runs started by custom messages. Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt.

`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input or block execution. `tool_result` handlers compose, with each handler seeing prior changes.

<a id="provider_stream_event"></a>

`provider_stream_event` fires for each parsed provider stream event before Pi normalizes it. The event identifies the provider, API, and model; `event.data` is the earliest structured value available to Pi, not necessarily the original HTTP bytes or SSE frame. Treat it as read-only because mutation can affect normalization. The event is notification-only and is not persisted.

Handlers are awaited in stream order, so slow handlers delay stream consumption. Handler errors are reported without changing the provider response. See [`debug-provider.ts`](../examples/extensions/debug-provider.ts) for an opt-in viewer that groups raw events by assistant message.

<a id="context_with_system"></a>

`context` transforms conversation messages without prompt and tool system messages; Pi restores that state afterward. Use `context_with_system` only when a request-local transformation must own the complete transcript, and keep a system message at index zero.

`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop. Use the exported event declarations for the complete validation and ordering contract.

<a id="cache_warming_decision"></a>

`cache_warming_decision` can override an idle prompt-cache refresh with `{ action: "warm" }` or `{ action: "stop" }`. The last handler that returns an action wins.

Tool calls from one assistant message can run in parallel.
Do not assume a sibling call or result exists when another tool event runs.
Use `ctx.signal` for nested work owned by an active turn; commands and idle session events often have no operation signal.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

<a id="custom-tools"></a>
<a id="register-tools"></a>

### Tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function.
Its result requires model-facing `content` and a `details` field for rendering or state reconstruction.
Use `details: undefined` when there are no structured details. If the tool makes nested model calls, include their `usage` in the result so session totals remain accurate.

Throw from `execute()` to produce a failed tool result.
Returning an object does not mark it as an error.
Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Use sequential execution when tools share mutable in-memory state.
File-mutating tools should wrap the complete read-modify-write operation with `withFileMutationQueue()`.
Truncate large model-facing results and tell the model where to read the complete output.

Declare `outputSchema` and return a matching `structuredContent` when the result is data. The model still receives `content`; programmatic callers such as codemode scripts receive `structuredContent` instead of the text. Tools without `outputSchema` are passed to scripts as their text content. To report a failure that still carries data, return the result with `isError: true` instead of throwing: the model sees an error, and scripts still receive `structuredContent`.

A tool can run other tools with `ctx.executeTool(name, args, { signal, onUpdate })`. Nested calls go through argument validation and the `tool_call` and `tool_result` handlers like model-issued calls, and emit `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`; all of these events carry `parentToolCallId`, and their `toolCallId` is assigned by pi as `<parent id>/<n>`. These ids do not appear as tool calls or tool results in the transcript. Nested calls do not add transcript entries: their results only reach the calling tool, which reports them itself, for example through `onUpdate` and `details`. The session keeps a bounded record of them (name, arguments, status, duration, error; never results) as `nestedCalls` on the calling tool's result message. It is used for compaction file lists and shown in HTML exports. Arguments over 8 KiB per call or 32 KiB per tool result are omitted, at most 256 calls are kept, and `complete: false` marks a record that lost anything. The `usage` of nested results, at every depth, is added to the calling tool's result `usage`, so a tool reports only its own usage, not that of the tools it called. `ctx.tools` lists the tools `ctx.executeTool()` can call. `tool_result` handlers that redact `content` should also replace `structuredContent`; replacing only `content` drops it.

See [`hello.ts`](../examples/extensions/hello.ts), [`todo.ts`](../examples/extensions/todo.ts), [`dynamic-tools.ts`](../examples/extensions/dynamic-tools.ts), and [`truncated-tool.ts`](../examples/extensions/truncated-tool.ts).

### Tool exposure

`exposure` controls how the model reaches a tool. "Callable" means callable from other tools through `ctx.executeTool()` (`ctx.tools`), as the `codemode` tool's scripts do:

- `direct` (default): declared to the model while active, and callable while active.
- `model-only`: declared to the model while active, never callable. Use it for tools that orchestrate other tools or ask the user.
- `codemode`: callable whenever registered, and listed by the `codemode` tool. Not declared to the model unless activated explicitly.
- `deferred`: like `codemode`, but codemode tools do not list it; `tool_search` can find and activate it.
- `hidden`: registered but unreachable. Re-register a tool with `exposure: "hidden"` to withdraw it, since tools cannot be unregistered.

`namespace: { name, aliases, description, instructions }` groups related tools, as MCP servers do. Codemode tools list a namespace under one heading with its `description`. `instructions` holds longer usage guidance; it is not listed, and codemode scripts read it with `describeNamespace(name)`. `aliases` are other names scripts may look the namespace up by, for example the server name `docs` for `mcp__docs`; a name and the same name as a script identifier (`my-docs`, `my_docs`) match alike.

Registering a `direct` or `model-only` tool activates it; the other exposures are not activated on registration. The active set (`pi.getActiveTools()`, `pi.setActiveTools()`) is the set of tools declared to the model. `pi.getAllTools()` reports each tool's `exposure`, `namespace`, `annotations`, and `reachesTools`.

`annotations` are hints about what a tool does, with the meaning of MCP tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. MCP tools carry the hints their server declares. Missing hints take the MCP defaults: a tool is not read-only, and may be destructive and reach an open world. The hints are not verified, but a permission extension can use them to decide which calls to confirm. This confirms the calls Codex asks approval for:

```typescript
pi.on("tool_call", async (event, ctx) => {
  const hints = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
  const needsApproval =
    hints?.destructiveHint === true ||
    (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
  if (needsApproval && !(await ctx.ui.confirm("Allow tool call?", event.toolName))) {
    return { block: true, reason: `${event.toolName} was not approved` };
  }
});
```

A tool that orchestrates other tools can adjust what the model sees while it is active with `prepareLoadout(loadout)`. It runs whenever the active tools change and receives the declared tools, the callable tools, and every registered tool with its exposure, namespace, and prompt guidelines. It returns replacement `descriptions` for declared tools (including its own) and `hiddenDeclarations`: active tools whose declarations requests leave out while they stay active and callable. The default system prompt leaves hidden tools out of its tool list and rules, and names no tool in the skills hint when the file reader is hidden, so the orchestrating tool should present their guidelines itself. `codemode` uses only this hook, `exposure`, `reachesTools`, and `ctx.executeTool()`, so another tool can implement the same behavior under a different name.

A tool that reaches other tools declares which ones a call may reach with `reachesTools(input)`: `"all"`, or the words of the input that may name them, where a word refers to every tool or namespace whose name it contains. `codemode` returns `"all"` for scripts that search or list tools and the words of the script otherwise; `tool_search` always returns `"all"`. Extensions that register tools late use it from their `tool_call` handler to finish registering the tools a call needs before it runs, as the MCP extension does for servers that are still connecting. The MCP extension also activates `codemode` or `tool_search` for MCP tools only when the tool of that name declares `reachesTools`.

### Activate tools dynamically

Register every tool first, keep optional tools inactive, and use `pi.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored.

Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.

### Tool rendering

A tool's `renderCall` and `renderResult` draw its calls in the interactive transcript and in HTML exports. `pi.registerToolRenderer((toolName, next) => renderers)` chooses renderers for calls to any tool, including tools that are not registered yet, such as MCP tools in a resumed session before their server connected. `next()` returns what the remaining resolvers (in extension load order), then the registered tool, would use, so `next() ?? mine` only fills in.

### MCP servers

`pi.registerMcpServer(name, config)` adds an MCP server for the current session. `config` has the shape of an `mcpServers` entry in [`mcp.json`](mcp.md): `command`, `args`, `env`, and `cwd` for stdio servers, `url`, `headers`, and `oauth` for HTTP servers, plus `exposure`, `toolExposure`, `description`, `enabled`, and `timeout`.

```typescript
pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira", exposure: "codemode" });
pi.unregisterMcpServer("jira");
```

Servers registered while the extension loads connect when the session starts, together with the `mcp.json` servers; servers registered later connect right away, and `pi.unregisterMcpServer()` closes the connection and makes the server's tools unreachable. Registrations are not saved: register again on every load, for example based on the extension's own settings. A server in `mcp.json` with the same name takes precedence, and `/mcp` shows the override. Registering the same name again replaces the extension's earlier registration; names registered by another extension, invalid names, and invalid configs throw.

The built-in MCP support connects registered servers. When nothing does, because another extension replaced it (see [MCP](mcp.md#other-mcp-extensions)), each registration is reported as an extension error. Other MCP extensions can connect registered servers too: read them with `pi.getMcpServers()` on `session_start` and handle the `mcp_servers_change` event for later changes.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>
<a id="use-extension-context"></a>

### Context and session changes

`ExtensionContext` provides the working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown.
Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls.

Command handlers receive `ExtensionCommandContext`, which adds operations for waiting until idle, reloading, tree navigation, and session replacement.
These operations are command-only because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the old context. Capture only plain data before switching, then use the fresh context supplied to `withSession` for session-bound work.

<a id="state-management"></a>
<a id="persist-state"></a>

### State

Choose storage based on how state participates in the conversation:

| State | Storage |
|---|---|
| Tool state that follows the active branch | Tool-result `details` |
| Durable data excluded from model context | `pi.appendEntry()` |
| Custom content stored and sent to the model | `pi.sendMessage()` |
| Data outside one session | External storage |

Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`.
Do not rebuild it from every file entry because abandoned branches represent alternative histories.
Register an entry or message renderer when custom stored content should appear in the transcript.

<a id="custom-ui"></a>
<a id="mode-behavior"></a>
<a id="interact-with-the-user"></a>
<a id="account-for-each-mode"></a>

### UI and modes

`ctx.ui` provides dialogs, notifications, status text, widgets, titles, editor access, and custom components.
Use `ctx.ui.custom()` only when the interaction needs its own rendering and input.
See [Terminal UI](tui.md) for component, focus, overlay, theme, and performance guidance.

Extensions load in interactive, RPC, JSON, and print modes.
Interactive mode provides the complete terminal UI.
RPC can forward supported dialogs and notifications through the [RPC Extension UI protocol](rpc-extension-ui.md), but not custom terminal components; JSON and print modes have no UI.
Guard terminal-only behavior with `ctx.mode === "tui"` and use `ctx.hasUI` for interactions supported by interactive and RPC clients.

Keep tool and event behavior independent from rendering so non-interactive modes remain functional.

<a id="error-handling"></a>
<a id="handle-errors-and-shutdown"></a>

### Errors and cleanup

Pi reports handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.

<a id="fatal-startup"></a>

#### Fail startup on purpose

One exception to "report and continue": a `session_start` handler that throws `ExtensionStartupError` (exported by `@earendil-works/pi-coding-agent`) fails session startup. Use it when continuing would be unsafe, for example when a file that decides what the session may read or run failed validation.

```typescript
import { type ExtensionAPI, ExtensionStartupError } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await loadPolicy(ctx.cwd);
    } catch (error) {
      throw new ExtensionStartupError("Invalid project policy", { cause: error });
    }
  });
}
```

Scope:

- Only `session_start` (startup, `reload`, `new`, `resume`, `fork`). Thrown from any other event it is an ordinary error: logged, nothing aborts.
- Remaining `session_start` handlers do not run. The error rethrown to the caller names the extension path, keeps your error as `cause`, and is itself an `ExtensionStartupError`.
- Print mode exits nonzero, RPC mode disposes the runtime and exits before reading commands, and the TUI restores the terminal and exits. None of them send a provider request.
- `ctx.shutdown()` is not a substitute: print mode has no shutdown handler, so it cannot fail closed.

While `session_start` handlers run, nothing reaches a provider:

- `pi.sendUserMessage()` and `pi.sendMessage(..., { triggerTurn: true })` (any `deliverAs`, including `nextTurn`) are held and replayed one at a time, in call order, once every handler completes. A failed replay is reported and does not prevent later held messages from running. If one emission fails fatally, the messages it already held are discarded and reported through the error listener (`send_user_message` / `send_message`) immediately, even while overlapping emissions still run; only messages deferred after that failure may be replayed by a later successful recovery. The held queue is the only place unplayed messages live, so this holds even when the fatal settles while an earlier replayed message is still running: everything not yet started is discarded and never replayed by a later recovery. A replayed message whose `input` handlers outlast a new `session_start` waits for that startup before it reaches the provider instead of failing with "still starting"; it fails only if the new startup is fatal. The same applies to a replay that lands while `agent_settled` handlers are still running: it waits for them under the replay's control rather than being deferred out of the held queue, and a fatal emission in that window discards it. A replayed message keeps the identity it was dequeued with: however long it is paused (an `input` handler, a turn it would be queued against), a fatal emission that settled meanwhile discards and reports it, even if a later recovery has already cleared the latch. Ordinary handler errors do not discard them. Held or not, every runtime send goes through the session's public `prompt()`, `sendUserMessage()` and `sendCustomMessage()`, so code that wraps those methods on `AgentSession.prototype` sees each one; a wrapper that forwards `options` unchanged keeps the replay's identity. A `session.prompt()` issued after the bind (print mode's initial message, for example) runs after the whole replay finishes, unless it passes `streamingBehavior`, in which case it is queued against that turn as usual.
- `ctx.compact()` is not held, since a handler may await `onComplete`. It calls `onError` right away. The `ModelRegistry` facade exposes `stream`, `streamSimple`, `complete`, `classify`, and `generateImages`: startup refusal reaches `stream`/`streamSimple` as their normal error event and final assistant result, and `complete` resolves that final assistant result; `classify` and `generateImages` resolve their normal error results (`stopReason: "error"`). None of these methods reject just because startup is pending, so awaiting one from a startup handler would otherwise deadlock startup. They are available after startup settles.
- Direct SDK calls (`session.prompt()`, `compact()`, summarizing `navigateTree()`) reject with a plain `Error` until `bindExtensions()` or `reload()` settles. Pi checks again immediately before invoking the provider, after authentication and request-header transforms, and a fatal failure aborts an in-flight agent run, compaction or branch summary; a request whose signal was aborted while it was being prepared never dispatches, even after a later recovery. The check rides on the agent loop's request options (like `sessionId`), so it survives a replaced `agent.streamFunction`; a custom stream function that bypasses `ModelRuntime` bypasses it too. This protection is session-scoped: calls made on a raw `ModelRuntime` supplied to the SDK are outside a session and are not gated. Await the bind first.
- `reload()` after any `bindExtensions()` call, even mode-only or empty bindings, re-emits `session_start`. Before the first bind it does not.

Recovery: a failed `session_start` leaves the `AgentSession` refusing `prompt()`, `sendUserMessage()`, triggered custom messages, `compact()`, and summarizing `navigateTree()` with an `ExtensionStartupError`. A fatal overlapping bind or reload also latches, even if another emission that began earlier succeeds; only a successful bind or reload operation that started after the fatal emission settles clears it. If `reload({ beforeSessionStart })` throws before `session_start` is emitted, that reload does not change the latch. Fix the cause, then call `bindExtensions()` or `reload()` again (`/reload` in the TUI). SDK callers should `dispose()` a session whose binding failed.

Hosts older than this feature log the error like any other and keep running. An extension that must not run there should feature-detect the export (`import * as sdk from "@earendil-works/pi-coding-agent"`, then check `"ExtensionStartupError" in sdk`) and refuse to continue without it. See [`fatal-startup.ts`](../examples/extensions/fatal-startup.ts).

Release resources in `session_shutdown` even when normal operation attempted cleanup.
Keep cleanup idempotent because cancellation, reload, session replacement, and process exit can converge on the same path.
Use `ctx.shutdown()` to request an orderly process shutdown.

<a id="examples-reference"></a>
<a id="use-examples-as-the-implementation-reference"></a>

## Examples and reference

The checked [extension examples](../examples/extensions/) cover tools, lifecycle events, commands, flags, shortcuts, state, rendering, providers, OAuth, remote execution, and terminal components.
Start with the smallest example matching your integration point.

Use [Custom Providers](custom-provider.md) for model-service integrations, [Terminal UI](tui.md) for custom components, and [Pi Packages](packages.md) to install or distribute extensions with other resources.
