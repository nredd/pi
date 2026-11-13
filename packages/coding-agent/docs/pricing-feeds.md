Published feed token baselines, checked 2026-11-13:

- This is a partial delivery of #55 and #56, not whole-provider certification. The frozen
  116-assessment archive baseline in [the coverage table](pricing-coverage.md) is unchanged.
  Source review of 1,714 operations is not certification of their prices.
- `packages/ai/src/catalog-feed-prices.json` retains source-shaped pricing for exact archived
  chat identities intersected with the official feeds. OpenRouter entries must advertise a
  supported synchronous chat endpoint; a batches-only selector is not a synchronous chat
  contract. No new catalogue identities, generated shards or published assets are introduced.
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

- Exact matched synchronous chat fixed-token and request-wide prompt-tier contracts use the
  existing `catalogueCost` seam. Both generation modes and runtime projection use the same
  dated corrections before explicit user overrides. Newer assessed catalogues are preserved.
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
  advertised Standard/base input, output and read tiers; all Gateway writes remain unavailable
  because the REST write field alone does not establish TTL. Numeric compatibility fields
  are retained separately from assessment eligibility.

Remaining unknowns and excluded charges:

- UTC/weekdays/overnight overrides, provider-varying or peak contracts, image/audio and other
  non-token rates, malformed/negative sentinel prices, missing exact IDs and non-chat operations
  remain unknown. Gapped, overlapping, finite-only or inconsistent Gateway brackets are not
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
