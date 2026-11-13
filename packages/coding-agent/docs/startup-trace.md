# Startup phase diagnostics

`startup-trace-v1` is opt-in diagnostic output, not a startup optimization or a latency
acceptance result. `PI_TIMING` remains a separate wall-clock debugging facility.

The caller creates an empty private regular file, opens it for writing and passes its
inherited descriptor (integer >= 3) as `PI_STARTUP_TRACE_FD`. Standard streams, pipes,
sockets, devices, nonempty files, multiple hard links, group/other-accessible files and
files owned by another user are refused. Permissions must be exactly `0600`. The caller
owns the descriptor for the process lifetime; Pi never opens a path, closes the descriptor,
retries a write or buffers records. Do not replace or reuse the descriptor during tracing.
Preflight compares exact device/inode identities against descriptors `0`, `1` and `2`
before any trace write. Both duplicated descriptors and independent opens of the same
standard-stream file are refused. If any standard descriptor is closed or cannot be
inspected, measurement is refused without changing application startup or its output.

Also set:

- `PI_STARTUP_TRACE_RUN_ID`: a fresh unpredictable 32-character lowercase hexadecimal
  sampler token, not a session or user ID.
- `PI_STARTUP_TRACE_ALIASES`: a JSON object mapping exact extension load identities to
  synthetic IDs matching `ext_[0-9]{3}`. Values must be unique. Use absolute resolved paths
  for files, `builtin:<name>` for built-ins and `<inline:<name-or-ordinal>>` for factories.
  At most 128 entries, 1024 characters per source identity and 16384 characters total.
  The manifest is private sampler input and is never written into the trace. Include
  pre-trust and built-in extensions, not just the final extension set. An unknown extension
  invalidates the measurement rather than leaking its identity.

Without `PI_STARTUP_TRACE_FD`, diagnostics do no descriptor/file access, manifest enumeration,
clock reads, timers or network work. The generated Node launcher loads the producer only
inside the opt-in branch, before compile-cache activation and runtime evaluation. A source,
SDK or standalone launcher without that hook cannot claim measured bootstrap time.

Each JSONL record has exactly these fields (the last two are optional):

```json
{"schema":"startup-trace-v1","seq":1,"clock":"node.hrtime.bigint","run_id":"0123456789abcdef0123456789abcdef","span_id":1,"parent_span_id":null,"phase":"core.bootstrap","event":"begin","t_ns":"0"}
```

- `seq` is a bounded increasing record ordinal; `span_id` identifies one span or milestone.
- `parent_span_id` is the active asynchronous parent or `null`. Concurrent operations have
  independent IDs, not a shared nesting stack. Queued work after a parent ends has no active parent.
- `t_ns` is an unsigned decimal string relative to one process-local `hrtime.bigint` origin.
- `event` is `begin`, `end` or `mark`. Every begin requires exactly one matching end.
- `status` is `ok`, `error`, `cancelled`, `skipped`, `cached` or `reused`.
- `extension_id`, when present, is a prevalidated synthetic alias only.

No record contains paths, command names/arguments, messages, exception text, settings,
environment dumps, URLs or model/provider IDs. Fixed phase names:

| Phase | Actual boundary |
| --- | --- |
| `core.bootstrap` | Generated Node launcher before compile cache/runtime loading, through `main()` entry; otherwise `skipped` |
| `model.catalog.initial` | Awaited `ModelRuntime.create()` in session services; supplied runtime is `skipped` |
| `model.registration` | Pending provider, native-provider and virtual-model registration loops in session services |
| `model.refresh.offline` | Awaited refresh with `allowNetwork: false` |
| `resources.reload` | Complete default-loader reload, including trust resolution |
| `resources.discovery` | Settings/package/extension-source resolution, including the pre-trust discovery pass |
| `extension.import` | Actual module loading, or explicit `cached`, `reused`, or inline/built-in `skipped` mark |
| `extension.factory` | Awaited factory, or explicit pre-trust `reused` mark |
| `resources.post_extensions` | Skills, prompts, themes, context and system-prompt loading through loaded-state assignment |
| `session.handlers` | Each awaited complete `session_start` emission, inside the existing startup gate |
| `session.bind.ready` | Bind after handlers, unhandled-MCP reporting and extension resource extension |
| `interactive.init` | Interactive initialization including editor wiring, binding and final startup render |
| `tui.first_commit` | First complete nonblank logical frame written by each initialized renderer |
| `command.extension.dispatch` | Awaited registered extension command handler, not prompt/provider dispatch |
| `trace.complete` | Process-exit integrity trailer, only when all spans closed and no producer error occurred |

A handler end is not deferred-send settlement, bind-ready is not an input acknowledgement,
and `ui.start()` is neither. A logical frame commit means terminal writes returned; it is
NOT physical paint or proof the terminal displayed a footer. A sampler must separately
observe paint/footer and verify its nonce command acknowledgement. Generic command dispatch
has only an ordinal, not a nonce. Correlate only a fixture that dispatches exactly the
intended command.

Limits are fixed: at most 512 records, 1024 UTF-8 bytes per record and 256 KiB total,
including a required integrity trailer. The producer reserves trailer capacity and stops
on any cap, unknown alias, invalid phase/status, duplicate/missing span, clock regression,
short write or write failure. Invalid preflight writes nothing. Other failures leave no
`trace.complete`. They never prevent the application from starting or change its errors.
An error/cancelled span may still have a structurally complete trace; that does not mean
startup succeeded. Consumers must validate expected phase coverage and statuses as well.

Consumers must reject a missing trailer, noncontiguous sequence, unknown/extra fields,
unknown phase/event/status/alias, malformed timestamps, time regression, duplicate IDs,
unmatched spans, cap violation or unexpected missing phase. Missing data is not zero.
A trailer alone does not prove a fixture's required work occurred. Session services,
custom resource loaders and direct SDK harnesses have different applicable phases.

External spawn/capture/ack timestamps belong to the observer's separate monotonic clock
domain. Never subtract absolute observer timestamps from these core timestamps. Bind
samples to authenticated runtime and fixture/materialization identities, alias-map digest,
flags and cache policy. Published runtimes without these hooks remain unmeasured; an
instrumented historical control needs a distinct derived-build identity. This facility
does not authorize changing published artifacts, performing inference or adopting a
benchmark baseline. Full quiet-runner measurement and future release admission are separate.
