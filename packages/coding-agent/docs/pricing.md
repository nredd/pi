Catalogue pricing:

- `retiredOn` (UTC `YYYY-MM-DD`, a real calendar date; the schema rejects `2026-02-30`) bounds a
  contract: priced before it, unpriced on and after it. `estimateTokenCost` returns
  `{cost: null, reason}`. `calculateCost` returns every cost field as 0 plus `unpriced: true` and a
  `reason` on `Usage["cost"]`. That 0 means UNKNOWN, not free: the provider may still bill (e.g. a
  rerouted alias), and the successor contract is not assessed here. A malformed `retiredOn` that
  bypasses the schema fails closed (unpriced) in both functions, so they always agree. Both take an
  optional `asOf` date for tests, defaulting to today (UTC).
- Unpriced handling, every consumer distinguishes the marker from a real $0:
  - Totals (`usage-totals.ts`, codemode, the durable `pi.usage` ledger) exclude unpriced entries
    from spend and keep a count. Footer, `/session` and the HTML export print the priced total plus
    `N unpriced`, or `unknown` when nothing was priced. The compaction and branch-summary line prints
    `cost unknown, unpriced`. `/session` per-model rows follow the same rule.
  - `cache-stats.ts` treats an unpriced message's miss cost as unknown (`costUnknown`, counted in
    `unpricedMisses`), never $0, and does not fall back to the catalogue read price.
  - `cache-warmer.ts` stops warming with reason `price contract retired (unpriced)`. Keeping the
    last known rates "approximate" was rejected: a warm is a real billed request, the rates belong
    to the retired contract (e.g. the rerouted `gemini-3.8-flash` bills 0.75/3.75/0.075 against
    1.25/10/0.125) and so the expected-savings test would compare two wrong numbers.
  - On an aggregate `Usage` (`combineUsage`, durable ledger) `unpriced` means some summed requests
    were unpriced and the totals are a priced subtotal; the ledger also counts them in
    `unpricedCalls`.
  - Session files and exports serialize the marker as-is. Older records without it are priced.
- Before `retiredOn`, `cost` retains numeric request-time arithmetic for existing callers. Recorded transcript
  costs are historical observations; updating this catalogue does not rewrite or reprice them.
- `cost.assessment` distinguishes `verified`, verified `free`, and `unknown`. Missing
  assessment is unknown, even when every numeric field is zero. Unknown does not mean
  unpublished: it can mean an unaudited source, unresolved alias or missing deployment mode.
- Verified token rates include official source, checked date, `usd-per-million-tokens` and
  applicable conditions. `unavailable` identifies categories for which a token rate does not
  apply; their numeric compatibility zero is NOT a free price. Use `estimateTokenCost`, not
  the compatibility arithmetic, to report an honest current-rate value.
- `estimateTokenCost(model, counters)` is synchronous and offline. It returns a new cost
  object, or `{cost: null, reason}`. It never mutates counters, recorded costs or transcripts.
  Resolve only exact provider/model identities; a similar name is not an alias mapping.
- The estimate assumes the standard/global list-price conditions stated in the assessment.
  It is not subscription cash spend or retrospective billing. Region, service tier, negotiated
  discounts and request-date prices cannot be reconstructed from counters alone.

Cache and context:

- Rates are USD per million tokens. `input` is uncached input; cached reads/writes must
  already be separated. Reasoning is a subset of output, not an additional charge category.
- Select the highest `inputTokensAbove` threshold strictly exceeded by
  `input + cacheRead + cacheWrite`. That tier prices the whole request, not just the excess.
- `cacheWrite` is the listed short-retention price. `cacheWrite1h` and `cacheWrite12h`
  are explicit prices, not universal multipliers. The strict estimator rejects a consumed
  lifetime with no applicable rate. Existing request-time callers retain their legacy 1h
  fallback only when no explicit price exists; this is not evidence of verification.
- `cacheWrite1h` and `cacheWrite12h` counters are subsets of total `cacheWrite`. Pass
  `shortCacheWrites: true` only when the remainder's short retention is known. Historical
  counters without retained TTL are unpriced rather than silently assigned a duration.
- The 12h counter is an estimator input; this change does not invent a provider-reported
  12h counter or rewrite old response records. Gemini cache storage is per token/hour,
  not a one-time token-write charge, and is excluded. Image/time/storage charges are not
  converted to tokens. Classifier entries need their own verified token-unit assessment.

Source audit, checked 2026-11-12:

- The complete public provider/operation inventory and remaining unknown coverage are
  [here](pricing-coverage.md). The audit does not certify unaudited rates as free.

- Official OpenAI Standard table [here](https://developers.openai.com/api/docs/pricing):
  `OPENAI_STANDARD_COSTS` in `packages/ai/src/catalog-pricing.ts` records the exact base
  table. Its explicitly listed long-context models use the published >272K tier; generation
  and runtime share both eligibility and tier construction, including `gpt-6.1-terra`. The
  table's absent cache categories are unavailable, not free. Batch/Flex/Fast/Ultrafast,
  regional/FedRAMP uplift and promotional expiry are not inferred from old records.
- Official Anthropic table [here](https://platform.claude.com/docs/en/about-claude/pricing):
  direct exact IDs for Fable 5/5.1, Opus 4.6/4.7/4.8/5/5.5, Sonnet 4.6/5/5.5 and Haiku
  5.5 carry the published base/read/5m/1h rates. Haiku's >100K tier is request-wide;
  the other assessed 4.6+ models do not acquire an old 200K premium. Dated or unmapped
  aliases are not automatically certified by matching their names.
- Official Gemini table [here](https://ai.google.dev/gemini-api/docs/pricing): direct
  `gemini-2.5-pro` (2026-11-12 audit) uses $1.25/$10/$0.125 through 200K input and $2.50/$15/$0.25 above
  it (input/output/read). Storage at $4.50 per million tokens/hour is outside token value.
  Google reroutes this alias to `gemini-3.8-flash` billing on 2026-12-01, so its assessment
  carries `retiredOn: 2026-12-01`: priced through 2026-11-30, unpriced from that date. The
  rerouted price is not applied here, so neither `estimateTokenCost` nor `calculateCost`
  prices the old rates past the date (see `retiredOn` above).
- Official AWS pricing [here](https://aws.amazon.com/bedrock/pricing/) supplies a chosen
  published baseline, not an account-specific invoice. AWS has no universal default region.
  This estimate uses the **Global Cross-region Inference**, **US East (N. Virginia)** selector,
  **Standard/on-demand**, **USD per million tokens** table, checked 2026-11-12. Exact
  `anthropic.*` physical IDs and AWS's recognized profile prefixes are normalized to this
  baseline, even when an ID names geographic routing. Regional uplifts, Batch, Flex,
  Priority, Reserved and negotiated discounts are excluded, not silently asserted absent.
  The assessment exposes this assumption on every price. Unknown physical IDs stay unknown.
- The AWS page's prices are resolved from its own public meter maps, not copied from
  Anthropic: the main USD map is [here](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json)
  (publication 2026-11-09), and the newer-model map is [here](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/cHVibGljLzljYzM1NWVlLTRjNjYtNDk0OC04MTg0LWVjMDFkYjBlNGNmMy8zMA.json).
  Join the page's `priceOf` keys to that selector's entries, preserving table column units.
  The separate public AWS offer index lacks some newer Anthropic products; that is not
  evidence of free service or a reason to block this published baseline.
- AWS Sonnet 5.5 baseline is $2/$10/$0.10/$2.50/$4 for input/output/read/5m-write/1h-write;
  Opus 5.5 is $4/$20/$0.20/$5/$8. Haiku 5.5 is $0.10/$0.50/$0.01/$0.125/$0.20 through
  100K input and $0.50/$2.50/$0.05/$0.625/$1 above it. The exact threshold is documented
  in its AWS model card [here](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html).
  Sonnet 5.5's exact physical/global/geo IDs and 1M context are documented [here](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html).
  Assessed Sonnet/Opus 4.6+ and Fable models do not inherit an older 200K premium.
  Older unassessed Sonnet models remain unknown until their applicable tiers are verified.
- AWS Nova 2 Lite, Lite, Micro and Pro use only the physical and profile IDs in their
  respective model cards, with the Standard/on-demand N. Virginia baseline checked 2026-11-13.
  Input/read/output USD per million are respectively `0.30/0.075/2.50`, `0.06/0.015/0.24`,
  `0.035/0.00875/0.14` and `0.80/0.20/3.20`. The write tariff is unavailable; implicit
  reuse does not create cache-read counters. Neither geographic profiles nor this baseline
  establish actual deployment routing or invoice cost.
- AWS model cards for [Astra](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.md),
  [Sol](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.md) and
  [Terra](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-terra.md)
  publish Standard Global CRIS input/read/output USD per million of `10/1/50`, `2/0.10/10`,
  and `1/0.05/5`. Above 272000 input, the entire request uses double input/read and 1.5x
  output rates. Only their documented physical, US and global IDs are assessed. The
  published 30-minute write rates (`12.50`, `2.50`, `1.25`, doubled above 272000) are the
  only supported explicit TTL (model cards and the AWS
  [prompt caching guide](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html),
  which lists 30 minutes as the sole `prompt_cache_options.ttl` value and notes Converse
  does not support explicit caching for these models): they price writes when the caller states short writes via
  `shortCacheWrites`, and unknown, 1h or 12h writes stay unpriced. No 12h tariff is
  inferred. The baseline is not an invoice; region, Ultrafast and other service tiers are
  excluded.
- Other generated providers/models retain their source rates for compatibility but are
  explicitly unverified unless an assessment is supplied. This is NOT a completed official
  price verification for every provider. Public source-feed numbers alone are not certified
  here; outstanding official-source verification is visible as unknown coverage.
- Exact OpenRouter and AI Gateway published token-baseline slices checked 2026-11-13,
  source hashes, cache-lifetime rules (Gateway writes unavailable except the documented Anthropic default 5m write) and remaining unknown dimensions are documented
  [here](pricing-feeds.md). They do not certify either complete provider catalogue.
- AI Gateway `-batch` IDs select the asynchronous Batch API, and synchronous requests do not
  accept them ([docs](https://vercel.com/docs/ai-gateway/models-and-providers/batch-processing.md)).
  They stay unknown unless a newer assessed catalogue (after 2026-11-13) supplies one: no batch
  rate schedule is admitted, and the default Standard rates are not assigned to them.
- Provider rate strings are plain decimal or scientific notation (`0.0000001`, `1e-7`) or
  finite non-negative numbers. Anything else, including radix literals such as `0x10`, is
  malformed: compatibility arithmetic falls back to 0 and the feed is never certified. A
  malformed AI Gateway bracket rate keeps the tier's base rate, as for OpenRouter overrides.
  AI Gateway evaluation (classifier) rates use the same parser.
- An older verified pi.dev assessment for an OpenRouter or AI Gateway id outside the archived
  feed becomes unknown (estimate null; `calculateCost` rates unchanged). "Older" means checked
  on or before the client audit date (`PRICING_CHECKED_AT`, 2026-11-12), except Gateway `-batch`
  ids, which use the 2026-11-13 feed date (above); an assessment checked later is kept as is.

Additional exact contracts, checked 2026-11-13:

- Cerebras Developer shared `gpt-oss-120b` and `qwen-3.8-27b` price cached input at
  the full input rate. Cache-write token tariffs are not established; trial credits and
  dedicated pricing are excluded. Model cards and caching terms are linked in the assessments.
- xAI Standard global `grok-4.7`, `grok-4.6`, `grok-4.5` and `grok-4.3` double
  input, cached input and output rates for the whole request at 200000 prompt tokens.
  Batch, Priority, regional uplift, product-only Fast, cache writes and non-token charges
  are excluded. See the [official table](https://docs.x.ai/developers/pricing).
- Google paid Standard `gemini-3.5-flash-lite` prices text input, output and cached-read
  tokens at $0.30/$2.50/$0.03 per million. Image and audio output and tool charges have
  separate units and are not distinguished by these counters. Cache storage is $1 per million token-hours, not a cache-write
  token tariff; tools and other non-token fees are excluded. No Vertex parity is assumed.
  Google's [model](https://ai.google.dev/gemini-api/docs/models) and
  [deprecation](https://ai.google.dev/gemini-api/docs/deprecations) pages, fetched 2026-11-13,
  supply lifecycle evidence below. Every Gemini assessment is paid Standard only, never
  the free-tier column, and Batch, Flex, Priority, grounding and other non-token charges are excluded.
- Dated Gemini contracts end at `retiredOn` (priced through the day before, unpriced from that UTC
  date) instead of applying the announced later price early, because one row cannot carry a date
  schedule. `gemini-4-argon` is `2/10/0.10` (input/output/read) through 2026-11-30 and Google lists
  `4/20/0.20` from 2026-12-01. `gemini-3.8-flash` and `gemini-3.6-flash` are `0.75/3.75/0.075` through
  2026-12-31 and Google lists `1.50/7.50/0.15` from 2027-01-01. Argon supports implicit caching only,
  so its cache-write category is unavailable; Flash cache storage ($0.50 per million token-hours,
  $1.00 from 2027-01-01) is a separate meter, not a write price.
  As for `gemini-2.5-pro`, both `estimateTokenCost` and `calculateCost` stop at the date; a call
  after it is marked `unpriced`, never $0 or the old rate.
- `gemini-2.5-flash` routes to `gemini-3.5-flash-lite` and bills at its rates from 2026-12-01. Those
  text, image and video rates (`0.30/2.50/0.03`) equal the alias's own, so the assessment carries
  no end date and shares the same constant as its target. Audio input (`$1.00`, cached `$0.10`)
  applies only before the reroute (the target bills audio at `$0.30`), cannot be distinguished by the
  counters and is excluded. `gemini-2.5-pro` still routes to
  `gemini-3.8-flash` on 2026-12-01, but that target is itself date-scheduled, so the alias stays
  bounded rather than priced afterwards.
- Also assessed from the same table, text/image/video input only (audio rates differ and are excluded):
  `gemini-2.5-flash-lite` `0.10/0.40/0.01`, `gemini-3.1-flash-lite` `0.25/1.50/0.025` (listed with an earliest
  shutdown of 2027-05-07, recommended replacement `gemini-3.5-flash-lite`, no price change announced), `gemini-3-flash-preview` `0.50/3.00/0.05`, and
  `gemini-3.1-pro-preview` plus `gemini-3.1-pro-preview-customtools` `2/12/0.20`, with `4/18/0.40` for the
  whole request above 200000 prompt tokens (`$4.50` per million token-hours storage excluded).
- Remaining Gemini IDs stay unassessed. Each was re-checked individually on 2026-11-13 against the
  [pricing](https://ai.google.dev/gemini-api/docs/pricing), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations),
  [models](https://ai.google.dev/gemini-api/docs/models) and [changelog](https://ai.google.dev/gemini-api/docs/changelog) pages.
  Only a published paid Standard rate for that exact ID, with a stated unit and validity, is assessed:
  - `gemini-3.7-flash`, `gemini-3.5-flash`: deprecations and the 2026-10-08 changelog say requests are
    "automatically routed" to `gemini-3.8-flash` and `gemini-3.6-flash`. Unlike `gemini-2.5-pro` and
    `gemini-2.5-flash`, no page says they are billed at the target's rates, and neither has its own
    pricing section. Routing is not a billing contract.
  - `gemini-flash-latest`, `gemini-flash-lite-latest`: the models page says a `latest` alias is hot-swapped
    on a release with 2 weeks email notice. The changelog's only switch (2026-01-21) is `gemini-flash-latest` to
    `gemini-3-flash-preview`, and `gemini-flash-lite-latest` is never named. No page states a current target
    or rate, so any price would be a guess that can change silently.
  - `gemini-3.1-flash-lite-preview`: shut down 2026-05-25 (deprecations, changelog), replaced by `gemini-3.1-flash-lite`.
    No current pricing section. `gemini-2.5-computer-use-preview-10-2025`: shut down (deprecations list 2026-07-28,
    models page marks it shut down), no pricing section, and the computer use tool is now billed as ordinary tokens
    of the selected model. No official source gives a current contract.
  - `gemma-4-*`: the pricing page lists free tier only, with paid input, output and caching "Not available". Zero
    rates here would not be a paid-deployment claim.
  - `gemini-2.5-pro` after 2026-12-01: target `gemini-3.8-flash` is itself date-scheduled, so one row cannot
    carry the schedule. A date-tier model would touch `models.ts` and the request-time cost surface (#83), and
    time-windowed prices stay unknown (#55/#56), and the feed's `expiration_date`/`deprecated_at` fields are ignored.
  - Archived IDs such as `gemini-3-pro-preview`, `gemini-2.5-pro-preview-03-25`, `-05-06`, `-06-05` and the
    2.0 family are listed as shut down with no pricing section, and are absent from the bundled catalogue.
  - Image-output, live-audio, TTS, embedding and agent IDs have per-unit meters the counters cannot express.

- `gemini-4-carbon` and `gemini-4-hydrogen` are priced on the page but absent from the bundled catalogue.

Generation and precedence:

- Both bundled shards and the existing JSON catalogue outputs receive an assessment for
  every model operation. Run the existing `generate-models`/`hydrate-model-data` paths;
  do not edit generated shards or introduce another catalogue. Release model-data hashes
  cover the assessment alongside its rates.
- Runtime remote and personalized catalogues apply the same narrow official corrections
  after restoring or fetching data, before user configuration. A newer explicitly assessed
  catalogue is not frozen at this client's checked date. Unknown entries remain unknown.
- A live OpenRouter `GET /models/user` price is the key's own rate, not a stale catalogue row.
  It is stored with `assessment: {status: "unknown", origin: "provider-live"}`, including
  after an offline restore, and catalogue corrections keep it even for an id in the archived
  feed. It is therefore billed by `calculateCost` but never certified by `estimateTokenCost`.
  Only OpenRouter rows are honoured, and the mark is stripped from fetched pi.dev rows, so a
  built-in, pi.dev or non-OpenRouter row that claims it is still corrected to the feed.
  Pricing projection preserves stable model identities across repeated reads without
  mutating source entries; in-place metadata and price updates are still observed.
- Explicit `models.json` cost overrides are topmost. An override without its own assessment
  clears inherited verification, so custom prices cannot keep a stale official-source badge.
  Custom model/extension definitions can supply an assessment through the existing cost schema.
- The offline consumer should report priced and unpriced event/token coverage separately,
  preserve recorded cost, and label any present-day estimate with its conditions. It must
  not refresh a catalogue, resolve auth or count a virtual router response as another call.
