# Timestamp verification

The source-only fixture `test/fixtures/timestamps-terminal.ts` registers a scripted local
provider and a fake `bash` operation. It makes no paid provider calls and executes no shell
commands. Its assistant instants are fixed at `2020-01-02T03:04:05Z` and
`2020-01-02T03:04:15Z`; the tool uses the first instant as call-context time.

From the repository root, use a private working directory, HOME and agent directory, not an
installed profile. For example, after creating `$case/home`, `$case/agent` and `$case/cwd`:

```sh
repo="$PWD"
cd "$case/cwd"
env -i PATH="$PATH" HOME="$case/home" TERM=xterm-256color TZ=UTC \
  PI_CODING_AGENT_DIR="$case/agent" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
  "$repo/pi-test.sh" --provider timestamp-proof --model faux-1 \
  --no-skills --no-prompt-templates --no-extensions \
  -e "$repo/packages/coding-agent/test/fixtures/timestamps-terminal.ts"
```

Exercise `/settings` -> **Show timestamps**, submit a prompt, expand the streaming tool,
scroll up, toggle timestamps off and on, resize, use `Ctrl+O`, `/reload`, exit and restart
with the same command plus `--continue`. Do not use a real provider or copy credentials into
the fixture home. Clipboard and URL assertions belong to the isolated native tests below;
manual `/copy` and URL clicks use the system clipboard/browser.

Recorded source-CLI boundary proof used a private Unix PTY and the real `ProcessTerminal`,
not `createInteractiveHarness()`. It started at 80x24, enabled timestamps through the real
settings UI, streamed the scripted response/tool, expanded with `Ctrl+O`, scrolled with
PageUp, toggled off/on while scrolled, resized to 120x40, reloaded, and restarted/resumed
from the private on-disk session. Decoding the PTY output with xterm showed, at both sizes:

```text
┄ 2020-01-02 03:04:15 +00:00┄┄┄...
│ PROOF DONE
│
│ 日本語 👀
│
│ line 1: stable recorded transcript content
```

The scrolled 80x24 frame retained `Jump to latest message`; the 120x40 frame retained the
expanded tool and complete prose. The restarted process rendered the recorded
`2020-01-02 03:04:05 +00:00` call-context labels, not its restart time. This is not live
desktop or native clipboard/browser proof. Detached tmux launch did not execute the fixture
on the test host; the successful boundary interaction used a private PTY instead.

`test/interactive-timestamps.test.ts` uses the production editor/settings/selection/URL
paths with clipboard/browser callbacks stubbed. It checks wrapped URL reconstruction,
metadata exclusion from copied selection, source-text equality, recorded custom entries,
hidden messages, exact recorded bash completion, live/replay labels, disclosure retention,
and narrow/wide resize. `entry-timestamp.test.ts` checks numeric/ISO precedence, epoch zero,
invalid times, midnight/year boundaries, UTC offsets and repeated DST hours. Component
checks preserve OSC133, content rows, native tool identity and renderer caches.

`interactive-timestamp-selection.test.ts` checks the actual selected text through the native
copy shortcut with copy-on-select disabled: timestamps off/on, narrow omitted labels, width
reflow and real tool disclosure. Toggling or reflow never copies implicitly. Entry/turn rules
are copy-excluded decoration with timestamps both off and on. These remain injected clipboard
checks, not a claim about the desktop clipboard.

Fullscreen selection validation compares copy-visible content, not timestamp/gutter text.
When rows move or wrap, it maps source offsets within the same native layout components and
requires the complete selected text and selected source-owner sequence to remain equal.
Source appended after an anchor may stream without invalidating it; changed source before an
anchor is not a safe offset mapping. Changed selected content, collapsed selected detail or
replaced owners (including intermediate owners with identical text) invalidate selection rather
than retaining stale coordinates.
`packages/tui/test/tui-alt-screen-selection-reflow.test.ts` covers native source mapping,
Unicode/hard wraps, preceding layout changes, streaming tail updates and navigation.
