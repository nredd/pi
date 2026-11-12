# Previous-prompt terminal proof

Native terminal interaction for [nredd/pi#29](https://github.com/nredd/pi/issues/29), 2026-11-11:

- macOS, Node 26.13.0, tmux 3.8, `TERM=xterm-256color`, `extended-keys off`.
- Dedicated tmux server/socket `issue29-proof`; empty `HOME`, isolated agent directory, `env -i`, `PI_OFFLINE=1`. No installed configuration, credentials, live session or desktop interaction.
- Real `InteractiveMode` with `ProcessTerminal`, a real `AgentSessionRuntime`/session, the faux provider and scripted bash operations. Three user prompts, 40 streamed tool-output rows and 28 assistant rows per turn. The third tool streamed for 14 seconds.
- The checked-in reproduction fixture is `test/fixtures/previous-prompt-terminal.ts`. The recorded run used an equivalent scratch wrapper with readiness/output markers. Both use the source resolver, not installed bundles.

Reproduce from the repository root in a disposable terminal, after installing dependencies and restoring the release model data:

```sh
sandbox=$(mktemp -d)
env -i PATH="$PATH" HOME="$sandbox" TMPDIR="$sandbox/" \
  PI_CODING_AGENT_DIR="$sandbox/agent" PI_OFFLINE=1 TERM=xterm-256color \
  node --import ./packages/coding-agent/src/experimental/source-resolver.ts \
  ./packages/coding-agent/test/fixtures/previous-prompt-terminal.ts
```

Interaction and captures:

1. Enter `FIRST CANONICAL PROMPT`, then `SECOND CANONICAL PROMPT` after the first settles. Each produces substantial tool and assistant output.
2. Enter `THIRD CANONICAL PROMPT`. While its tool runs, type `retained  draft`, press Left, then F8. The latest prompt is selected while still clamped near the bottom, and the jump-to-latest indicator appears. Its beginning was already visible below the viewport top.
3. Press F8 again during streaming. Capture `04-repeat.txt` starts with `SECOND CANONICAL PROMPT`, not an assistant/tool row. Draft remains `retained  draft`.
4. Resize `100x30` -> `80x24` and press Ctrl+O. Capture `05-resize-disclosure.txt` remains anchored to the second prompt, with expanded `proof-tool-2` output and a running indicator. Type `X`: the draft becomes `retained  drafXt`, proving cursor and focus survived.
5. Press F8 again. Capture `07-first.txt` starts with `FIRST CANONICAL PROMPT`, retaining `retained  drafXt`.
6. Press Ctrl+End. Clear the draft with Ctrl+A/Ctrl+K and submit `/previous-prompt`. Capture `09-slash.txt` starts with `THIRD CANONICAL PROMPT`, with no command transcript entry. This works with extended keys disabled.
7. Press Ctrl+End again. Capture `10-return-bottom.txt` ends at `ANSWER 3 substantial transcript row 27`; there is no jump-to-latest indicator.

Selected exact capture rows (blank/padding rows omitted):

```text
SECOND CANONICAL PROMPT
▾  $ proof-tool-2
   TOOL 2 substantial output row 0
   TOOL 2 substantial output row 9
── ⠋ Working ───────────────────────────────────────────────────────────────────
retained  drafXt
```

```text
FIRST CANONICAL PROMPT
▾  $ proof-tool-1
retained  drafXt
```

```text
│ ANSWER 3 substantial transcript row 26
│ ANSWER 3 substantial transcript row 27
```

Raw ANSI output and full numbered captures remain in the local `~/code/.issue-29-build/` evidence directory. Immediate `tmux send-keys; capture-pane` can capture the previous frame: `08-bottom.txt` did so and is not return-bottom evidence; `10-return-bottom.txt` is the settled capture. The proof server was stopped afterward.

The deterministic native/interactive tests separately assert follow state, unclamped reanchoring after output growth, partial/aligned/oldest/empty navigation, replay identity, attachment/skill grouping, remap/reload, dialogs and selection invalidation. This terminal proof does not claim physical Kitty-keyboard or OS/window-shortcut coverage.
