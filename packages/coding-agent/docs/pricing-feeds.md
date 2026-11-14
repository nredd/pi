Published feed token baselines, checked 2026-11-13:

- This is a partial delivery of #55 and #56, not whole-provider certification. The frozen
  116-assessment archive baseline in [the coverage table](pricing-coverage.md) is unchanged.
  Source review of 1,714 operations is not certification of their prices.
- `packages/ai/src/catalog-feed-prices.json` retains source-shaped pricing and request limits for exact archived
  chat and classifier identities intersected with the official feeds, keyed by the existing
  `type:id` operation convention. OpenRouter entries must advertise a supported synchronous
  chat or decisions endpoint; a batches-only selector is not a synchronous chat contract. No new catalogue identities, generated shards or published assets are introduced.
- OpenRouter source [here](https://openrouter.ai/api/v1/models?output_modalities=all), SHA-256
  `16b6630b709efa5cfe6562f7b4e377e59ce2ee116087a5cbe668f7210ea999b6`;
  schema [here](https://openrouter.ai/docs/api-reference/list-available-models).
  The archived comparison matched 438 of 479 operations, not 438 verified token contracts.
- AI Gateway source [here](https://ai-gateway.vercel.sh/v1/models), SHA-256
  `39d5eb7a81c6505c3bfca10baee8b7c349127ac8a58672cd42f0edfb4ea898a9`;
  discovery [here](https://vercel.com/docs/ai-gateway/models-and-providers) and pricing
  [here](https://vercel.com/docs/ai-gateway/pricing). The comparison matched 290 of 311
  operations, not 290 certified contracts.

Supported slices:

- Exact matched synchronous chat and classifier fixed-token and request-wide prompt-tier contracts use the
  existing `catalogueCost` seam. Both generation modes and runtime projection use the same
  dated corrections before explicit user overrides. Newer assessed catalogues are preserved.
  Exact feed-published context and output limits populate the existing assessment envelope;
  OpenRouter selects its top-provider context like the existing catalogue normalizer, rather
  than a larger outer context. Missing/zero context limits remain unknown. The merged estimator
  rejects over-limit requests and evaluation before the check date.
- Exact classifier operations such as OpenRouter `cloudflare/clef` and `cloudflare/clef-flash`
  admit input rates 0.192 and 0.019 USD/million tokens, respectively, with published zero output
  rates. Gateway `convaiinnovations/laya` admits input 0.0105 and output zero. Missing cache
  categories remain unavailable. These contracts do not promote the same IDs as chat models.
- The existing source normalizers now live in `catalog-pricing.ts`; their original provider
  and generator paths re-export them. This keeps the `models` entry point provider-free and
  within its existing import-graph budget, without copying conversion logic.
- OpenRouter prices are USD/token, converted once to USD/million tokens by `openRouterCost`.
  Strict thresholds remain strict: `anthropic/claude-haiku-5.5` switches above 100000 and
  `anthropic/claude-sonnet-4.5` above 200000 total prompt tokens, including cached input.
  All applicable overrides are evaluated in original source order, later values winning per
  price key. An omitted key does not erase another applicable override.
- The OpenRouter schema explicitly separates default 5m and extended 1h cache-write prices.
  Only records with this explicit paired lifetime contract admit writes. A numeric write field
  without a declared lifetime remains unavailable, not a guessed 5m write. Retained request TTL
  counters are still required by `estimateTokenCost`.
- AI Gateway uses the existing REST snake_case bracket normalizer. Its inclusive 272001
  minimum becomes strict `inputTokensAbove: 272000`, pricing the entire request. Sparse
  initial brackets inherit the published base rate until their first minimum.
- Exact `alibaba/qwen-3-14b` has input/output 0.12/0.24 USD/million tokens. Its absent read
  and write fields are unavailable, not verified zero/free. `openai/gpt-6.1-sol` admits its
  advertised Standard/base input, output and read tiers. The Gateway REST write field alone
  does not establish a TTL, so Gateway writes are unavailable by default. Exception, checked
  2026-11-14 against the Gateway [caching docs](https://vercel.com/docs/ai-gateway/models-and-providers/prompt-caching):
  Anthropic entries default to five minutes (omitted `cache_ttl`), written at 1.25x base input
  (1h at 2x). An `anthropic/` row whose base rate and every bracket price writes at exactly 1.25x
  input admits its write rate as the default 5m write only. The feed has no 1h write field, so
  1h/12h counters and unknown lifetimes stay unavailable, and other vendors' writes are never
  inferred from this. Numeric compatibility fields are retained separately from assessment
  eligibility.
- Each verified row's conditions text names the published dimensions this baseline does not value
  (`regional`, `fast`, `service_tiers`, `web_search`) so they are not read as absent.

Remaining unknowns and excluded charges:

- Unsupported conditions now carry a precise reason: UTC window/weekday overrides, provider
  variation, peak pricing and each non-token field are named in the assessment `reason`.
- Not assessed, checked 2026-11-14: Gateway `deprecated_at` and OpenRouter `expiration_date`
  are not mapped to `retiredOn`. OpenRouter documents `expiration_date` only as the "deprecation
  date for the model endpoint", and no Gateway doc defines `deprecated_at`, so neither is
  evidence of the last day a contract is billable. Candidates in the frozen snapshot include
  Gateway `inception/mercury-2` (2026-11-15) and OpenRouter `openai/gpt-5` (2026-12-11).
- OpenRouter rates move within a day: 8 of 310 archived rows differed between the 2026-11-13
  snapshot and a 2026-11-14 fetch (Gateway: 0 of 263). The snapshot stays a dated baseline and
  is not refreshed by this change. Gateway promotions (e.g. the GPT-5.6 Sol 50% discount, ended
  2026-09-18) are not in the feed prices admitted here.

- UTC/weekdays/overnight overrides, provider-varying or peak contracts, image/audio and other
  non-token rates, malformed/negative sentinel prices, missing exact operation IDs and image operations
  remain unknown. Explicit non-Standard Gateway selectors, e.g. `openai/gpt-4.1-fast`,
  `anthropic/claude-opus-5.5-fast` and `deepseek/deepseek-v4.1-flash-fast`, are excluded by
  exact source identity, not stripped or relabelled as Standard. Gateway `-batch` IDs are
  async Batch API selectors that synchronous requests reject, so they are unknown too
  (all `-batch` rows in the archive, no batch schedule is admitted, unless a newer assessed catalogue (after 2026-11-13) supplies one). Gapped, overlapping, finite-only or inconsistent Gateway brackets are not
  flattened into a complete contract. Missing categories cannot become free through legacy zeros.
- Each admitted assessment is a chosen published default/Standard global **token baseline**.
  Search charges, image/request counters, regional routes, Fast/service-tier prices and optional
  account add-ons are not valued. Their actual charges remain unknown, even when token baseline
  arithmetic is available. The estimator does not infer that a historical request omitted those
  dimensions; a consumer must not label this baseline as a complete invoice reconstruction.
- The 41 OpenRouter and 21 Gateway missing operations are not assigned replacement identities
  or first-party prices. Their absence from a current feed does not prove historical prices
  never existed. Batch/free aliases are never stripped to find another contract.
- Current-rate estimates remain separately labelled and do not modify recorded costs, events,
  IDs or counters. API-equivalent value is not subscription cash. No live inference, authenticated
  catalogue refresh, release, pin change or activation is part of this source change.
