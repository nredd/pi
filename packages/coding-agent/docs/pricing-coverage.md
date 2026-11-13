Public catalogue coverage, checked 2026-11-12:

- Inventory baseline: the public model-data archive from `v1.3.0-nredd.11`, assessed by
  `catalogueCost`; this is not a private configuration or deployment inventory. It does not
  alter that immutable release or claim to describe a newer remote catalogue.
- Every operation is counted. `Verified` means the current standard/global token rates
  described in [the pricing audit](pricing.md), not complete retrospective billing.
  Unsupported price categories can still make an individual event unpriced.
- `Unknown` means the applicable official price/alias/unit conditions are not established
  by this audit. It does not mean the service is free or that its vendor publishes no prices.
  Remaining source verification is outstanding; do not claim whole-catalogue rate certification.
- All-zero unassessed rates are not promoted to verified free. The existing generator emits
  per-entry assessments for bundled and public JSON output, including newly discovered models;
  use those entries rather than treating this dated inventory table as a runtime catalogue.

| Provider | Chat | Classifier | Image | Verified | Free | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `amazon-bedrock` | 193 | 0 | 0 | 70 | 0 | 123 |
| `ant-ling` | 3 | 0 | 0 | 0 | 0 | 3 |
| `anthropic` | 17 | 0 | 0 | 11 | 0 | 6 |
| `azure` | 45 | 0 | 0 | 0 | 0 | 45 |
| `baseten` | 22 | 0 | 0 | 0 | 0 | 22 |
| `cerebras` | 2 | 0 | 0 | 0 | 0 | 2 |
| `cloudflare-ai-gateway` | 57 | 0 | 0 | 0 | 0 | 57 |
| `cloudflare-workers-ai` | 18 | 3 | 0 | 0 | 0 | 21 |
| `deepseek` | 2 | 0 | 0 | 0 | 0 | 2 |
| `fireworks` | 22 | 0 | 0 | 0 | 0 | 22 |
| `github-copilot` | 36 | 0 | 0 | 0 | 0 | 36 |
| `google-vertex` | 14 | 0 | 0 | 0 | 0 | 14 |
| `google` | 23 | 0 | 0 | 1 | 0 | 22 |
| `groq` | 7 | 0 | 0 | 0 | 0 | 7 |
| `huggingface` | 78 | 0 | 0 | 0 | 0 | 78 |
| `kimi-coding` | 4 | 0 | 0 | 0 | 0 | 4 |
| `meta` | 6 | 0 | 0 | 0 | 0 | 6 |
| `minimax-cn` | 3 | 0 | 0 | 0 | 0 | 3 |
| `minimax` | 3 | 0 | 0 | 0 | 0 | 3 |
| `mistral` | 40 | 0 | 0 | 0 | 0 | 40 |
| `moonshotai-cn` | 4 | 0 | 0 | 0 | 0 | 4 |
| `moonshotai` | 4 | 0 | 0 | 0 | 0 | 4 |
| `nvidia` | 20 | 0 | 0 | 0 | 0 | 20 |
| `openai-codex` | 9 | 0 | 0 | 8 | 0 | 1 |
| `openai` | 44 | 1 | 0 | 26 | 0 | 19 |
| `opencode-go` | 29 | 0 | 0 | 0 | 0 | 29 |
| `opencode` | 84 | 2 | 0 | 0 | 0 | 86 |
| `openrouter` | 396 | 23 | 60 | 0 | 0 | 479 |
| `qwen-token-plan-cn` | 20 | 0 | 0 | 0 | 0 | 20 |
| `qwen-token-plan-individual` | 9 | 0 | 0 | 0 | 0 | 9 |
| `qwen-token-plan` | 20 | 0 | 0 | 0 | 0 | 20 |
| `radius` | 29 | 0 | 0 | 0 | 0 | 29 |
| `together` | 17 | 0 | 0 | 0 | 0 | 17 |
| `typesafe` | 0 | 1 | 0 | 0 | 0 | 1 |
| `vercel-ai-gateway` | 301 | 10 | 0 | 0 | 0 | 311 |
| `xai` | 4 | 0 | 0 | 0 | 0 | 4 |
| `xiaomi-token-plan-ams` | 4 | 0 | 0 | 0 | 0 | 4 |
| `xiaomi-token-plan-cn` | 4 | 0 | 0 | 0 | 0 | 4 |
| `xiaomi-token-plan-sgp` | 4 | 0 | 0 | 0 | 0 | 4 |
| `xiaomi` | 6 | 0 | 0 | 0 | 0 | 6 |
| `zai-coding-cn` | 4 | 0 | 0 | 0 | 0 | 4 |
| `zai` | 7 | 0 | 0 | 0 | 0 | 7 |
| Total | 1614 | 40 | 60 | 116 | 0 | 1598 |

Source follow-up, checked 2026-11-13:

- The exact `openai-codex/gpt-6.1-terra` selector is now assessed as API-equivalent,
  using the [public Codex guide](https://developers.openai.com/codex/models),
  [exact API model card](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md)
  and [Standard pricing](https://developers.openai.com/api/docs/pricing).
- USD per million tokens: input `1`, output `5`, cache read `0.05`, 30m write `1.25`,
  12h write `2.50`. Above `272000` total input tokens, including cached input and
  writes, input/cache rates double and output is `1.5x` for the whole request.
- Generated source catalogues include this exact Codex selector with a conservative
  `272000` default context limit. This does not discover or promise account availability,
  measure subscription cash, or certify unrelated aliases. Missing retained write TTL
  still makes an event unpriced; an unsupported one-hour write is not a 30m write.
- The frozen archive table above remains unchanged: Terra is not an additional operation
  in that dated archive. This source change does not modify `.11`, publish a release,
  advance selected pins or activate a new catalogue.

Claude source follow-up, checked 2026-11-13:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) supplies
  Standard global USD per million token rates for `claude-fable-5-2`: input `8`, output
  `40`, read `0.2`, 5m write `10`, 1h write `16`.
- The exact [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview),
  [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview) and
  [Sonnet 4.5](https://platform.claude.com/docs/en/models/sonnet-4-5/overview) cards
  map each alias to its dated snapshot. Their input/output/read/5m/1h rates are respectively
  `1/5/0.1/1.25/2`, `5/25/0.5/6.25/10`, and `3/15/0.3/3.75/6`.
- Estimates reject requests above each documented context or output limit; unknown write
  lifetimes remain unpriced. Sonnet 4.5 is deprecated and retires on 2026-11-30. Since
  the published date has no time of day, estimates conservatively stop at the start of
  that UTC date. An optional evaluation date is for current-list-price comparison, not
  reconstruction of historical billing.
- These are first-party contracts only, not inferred Bedrock prices. The dated archive table
  remains an immutable baseline, not a claim that these source changes have shipped.

Bedrock source follow-up, checked 2026-11-13:

- Exact Nova 2 Lite, Lite, Micro and Pro model-card IDs are assessed at the Standard/on-demand
  N. Virginia baseline, with the cache-write tariff unavailable. Exact `openai.gpt-6-astra`,
  `openai.gpt-6.1-sol` and `openai.gpt-6.1-terra` plus their documented `us.` and `global.`
  IDs are assessed at the Standard Global CRIS baseline, with 30m writes priced only when
  stated. See [the pricing audit](pricing.md) for rates; regional premiums are not added.
- The frozen archive table above remains unchanged and is not recounted for these identities.
  This source change does not modify `.11`, publish a release or advance selected pins.
