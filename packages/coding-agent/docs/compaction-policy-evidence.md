# Compaction policy evidence

Retrieved 2026-11-12. These are product defaults, examples or hard-capacity metadata, NOT
quality-optimal recommendations transferable to Pi's client-side summaries. The provider
recommendation mapping is empty. `min(128000, floor(0.5 * inputBudget))` is our application
fallback, not provider advice or a measured optimum.

| Source | Exact passage | Classification |
| --- | --- | --- |
| [Anthropic threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) | "Messages API: Opt in with a `compact_20260112` edit; compaction starts at 150,000 input tokens by default." | Opt-in server-side Messages feature for documented supported models, not Pi summaries. |
| [Claude Code](https://code.claude.com/docs/en/model-config) | "Models running with a native 1M window compact before the window fills, at about 967K tokens by default." | Claude Code product default, not universal provider advice. |
| [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction) | `context_management=[{"type": "compaction", "compact_threshold": 200000}]` | Example code, not a universal threshold. |
| [OpenAI model metadata](https://developers.openai.com/api/docs/models/gpt-5.3-codex) | "400,000 context window", "Maximum input tokens: 272,000", "128,000 max output tokens" | Distinct hard limits. Do not subtract maximum output again from an explicit input ceiling. No catalog limits added by inference. |
| [Gemini CLI settings](https://github.com/google-gemini/gemini-cli/blob/488d71b8c9fc3700cb454f22c5553a680d4fb288/docs/cli/settings.md) | `model.compressionThreshold`: "The fraction of context usage at which to trigger context compression (e.g. 0.2, 0.3)." Default `0.5`. | Immutable source revision of a CLI product default. |
| [xAI compaction](https://docs.x.ai/developers/advanced-api-usage/context-compaction) | "A typical pattern is to call the Compaction API every N turns inside an agent loop, or once whenever your bookkeeping shows the rendered context above a threshold you've chosen for your workload." | Workload-specific timing, no universal numerical threshold. |

Web documentation has no immutable revision exposed here. Recheck it before adding any exact
provider/model/client-surface recommendation. Names, advertised capacity, other products and
examples alone do not establish such a recommendation.

# Implementation decision

Use one pure resolver for known and unknown capacities. Preserve selected-model reserve and
retention semantics; only the operating target additionally consults the physical route. The
request captures that route before compaction and re-prepares context and request gates without
routing again. Settings managers remain session-local, including child sessions sharing a model
runtime. A failed/no-progress automatic attempt does not shrink summary or retained-history
budgets. Unchanged history is not repeatedly compacted by successive checks.
