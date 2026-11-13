Catalogue pricing:

- `cost` retains numeric request-time arithmetic for existing callers. Recorded transcript
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
  table. Its explicitly listed long-context models use the published >272K tier. The
  table's absent cache categories are unavailable, not free. Batch/Flex/Fast/Ultrafast,
  regional/FedRAMP uplift and promotional expiry are not inferred from old records.
- Official Anthropic table [here](https://platform.claude.com/docs/en/about-claude/pricing):
  direct exact IDs for Fable 5/5.1, Opus 4.6/4.7/4.8/5/5.5, Sonnet 4.6/5/5.5 and Haiku
  5.5 carry the published base/read/5m/1h rates. Haiku's >100K tier is request-wide;
  the other assessed 4.6+ models do not acquire an old 200K premium. Dated or unmapped
  aliases are not automatically certified by matching their names.
- Official Gemini table [here](https://ai.google.dev/gemini-api/docs/pricing): direct
  `gemini-2.5-pro` uses $1.25/$10/$0.125 through 200K input and $2.50/$15/$0.25 above
  it (input/output/read). Storage at $4.50 per million tokens/hour is outside token value.
  Its published future reroute is not applied as if it already happened.
- Official AWS pricing [here](https://aws.amazon.com/bedrock/pricing/) and public offer index
  [here](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/region_index.json)
  require region, inference profile scope and service mode. A public offer SKU must be
  matched to its dimensions/units, not a similarly named direct-provider rate. The inspected
  2026-11-11 `us-east-1` offer did not expose Sonnet 5.5 products by that name; absence
  is not a zero price or permission to substitute Anthropic. Deployment-specific rates
  remain unresolved. No credentials or inference request are required for this source audit.
- Other generated providers/models retain their source rates for compatibility but are
  explicitly unverified unless an assessment is supplied. This is NOT a completed official
  price verification for every provider. Public source-feed numbers alone are not certified
  here; outstanding official-source verification is visible as unknown coverage.

Generation and precedence:

- Both bundled shards and the existing JSON catalogue outputs receive an assessment for
  every model operation. Run the existing `generate-models`/`hydrate-model-data` paths;
  do not edit generated shards or introduce another catalogue. Release model-data hashes
  cover the assessment alongside its rates.
- Runtime remote and personalized catalogues apply the same narrow official corrections
  after restoring or fetching data, before user configuration. A newer explicitly assessed
  catalogue is not frozen at this client's checked date. Unknown entries remain unknown.
- Explicit `models.json` cost overrides are topmost. An override without its own assessment
  clears inherited verification, so custom prices cannot keep a stale official-source badge.
  Custom model/extension definitions can supply an assessment through the existing cost schema.
- The offline consumer should report priced and unpriced event/token coverage separately,
  preserve recorded cost, and label any present-day estimate with its conditions. It must
  not refresh a catalogue, resolve auth or count a virtual router response as another call.
