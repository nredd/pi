# Fork releases

`nredd/pi` keeps the upstream package names and releases exactly four tarballs, needed by `nredd/tap` and `nredd/pi-harness`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core` (`packages/agent`) and `@earendil-works/pi-ai`, plus `SHA256SUMS`.

## Cut a release

Fork releases keep all upstream package versions at `1.3.0` until the upstream base changes.
Increment only the `-nredd.N` tag suffix; do not run the upstream `release:patch` script,
rename packages or publish core packages to npm. Naming/publication work in [#120](https://github.com/nredd/pi/issues/120) is tabled.

1. Obtain green PR and pi-harness stack evidence for the exact release commit.
2. Create and push an owner-signed annotated `vX.Y.Z-nredd.N` tag on a commit reachable from `main`. CI verifies the SSH signature against the owner's two pinned signing keys and rejects branches or tag names outside that contract. This is *not* the trust boundary: the workflow executes from the tagged commit, so a writer could tag a commit whose edited workflow skips that check. The creation control is the tag ruleset `Fork release tags` (id `25519508`, [here](https://github.com/nredd/pi/rules/25519508)), which blocks creating, moving or deleting `refs/tags/v*-nredd.*` for everyone except the repository admin role (the owner, the only admin). Inspect with `gh api repos/nredd/pi/rulesets/25519508`; never weaken it from CI.
3. The `Fork release` workflow restores `@earendil-works/pi-ai@X.Y.Z` model data, runs `npm ci --ignore-scripts`, `npm run build:offline`, `npm run check`, builds `packages/env`'s daemon, runs `./test.sh`, then packs `packages/coding-agent`, `packages/tui`, `packages/agent` and `packages/ai`.
   `build:offline` applies the fork-only additions shared with the generator in `packages/ai/scripts/fork-models.ts` after validating the restored data. It preserves unrelated frozen entries and the generation timestamp, updates the manifest hashes, and does not query live feeds. `./test.sh` packs `pi-ai` and coding-agent and checks both the JSON catalog and the bundle's offline runtime for the new IDs, conservative limits, unknown pricing and Azure exclusion (`scripts/fork-catalog.test.mjs`).
4. CI extracts the packed coding-agent bundle and requires `DEFAULT_REASONING_SUMMARY="detailed"` in at least one bundled chunk (the shared default is hoisted into a generic chunk, so this is stronger than grepping only `*responses*.js` for `"detailed"`, but it does not prove every chunk). It writes `SHA256SUMS`, attests all four tarballs with GitHub build provenance, and creates a new GitHub release. Existing releases are never overwritten.
5. Verify the release bytes before changing the tap or dotfiles. `pi-harness` requires the release `SHA256SUMS` and provenance for all post-automation tags. Releases are authenticated by provenance of CI-built bytes, not reproducible rebuilding: dry-run [39502658787](https://github.com/nredd/pi/actions/runs/39502658787) rebuilt `v1.3.0-nredd.7` with different SHA-256 values. Rebuilds will differ; reproducibility is tracked in [nredd/pi-harness#84](https://github.com/nredd/pi-harness/issues/84).

## `v1.3.0-nredd.13` preparation

Audited `v1.3.0-nredd.12..c17754d3e` (three commits):

- [#117](https://github.com/nredd/pi/pull/117) adds GPT-6.2 Sol/Astra; [#124](https://github.com/nredd/pi/pull/124) makes the frozen offline catalog ship them. The existing `pi-ai` and coding-agent `[Unreleased]` entries already cover the user-visible contract (OpenAI/Codex only, 272K default, direct API opt-in limits, unknown pricing, no Azure). No changelog gap was found.
- [#119](https://github.com/nredd/pi/pull/119) is repository audit tooling and CI, not package runtime behavior; #124 also removed its withdrawn advisory exception. No package changelog entry is needed.
- No other package changed. Released sections are untouched and the four packed package versions remain `1.3.0`.

Before tagging, verify the actual packed `pi-ai` catalog and coding-agent runtime for both GPT-6.2 IDs
(`scripts/fork-catalog.test.mjs`), plus the exact candidate's fork checks and matching pi-harness stack evidence.
After publication, download all four tarballs plus `SHA256SUMS`, verify every checksum and
`fork-release.yml` GitHub attestation, and inspect the coding-agent tarball for valid settings,
models, keybindings and theme schemas before opening downstream pin PRs.

## Release signing trust

The inline `allowed_signers` policy in `.github/workflows/fork-release.yml` accepts only
principal `nredd` in SSH namespace `git` (Git uses it for tag signatures):

- MacBook: `SHA256:YHzjQXY3SPl20zOMMOoNz8o4dk+eOZEi8FA+vS6nwFY`.
- Mac mini (`nick-mac`): `SHA256:+16+g7/7VKDJ2svgiuGIbfPnPF9pKKSU/h51+K9iHdk`.

Keep the MacBook key: historical tags were signed with it. The Mac mini key also authorizes
future owner-signed releases, including `.8`; this change creates no release or tag.
`scripts/fork-release-signers.test.mjs` pins both fingerprints and exercises Git verification
with disposable keys in both trusted slots, an unknown key, and a wrong namespace.
Run it with `node --test scripts/fork-release-signers.test.mjs`.
The policy stays inline because dry-runs check out the historical tag, whose tree may not
contain a separate signer file. No workstation `~/.ssh/allowed_signers` is consulted.

Consumers do not duplicate this SSH allowlist: pi-harness verifies release checksums and
`fork-release.yml` GitHub attestations; dotfiles verifies the promoted stack's
`promote-stack.yml` attestation; the Homebrew tap pins tarball checksums.
Those distinct trust boundaries remain unchanged.

## Pull request CI

`ci.yml` runs on pushes and pull requests to `main`, plus pushes to `security/**`. The integration
branch is `main` (the retired `nredd/v1.3.0` line was folded into it). Upstream pulls are manual
merges into `main` via PR; a merge commit is allowed. The push run validates a candidate head
independently of PR event delivery. Both events may run when a PR is open. Require a real run on the
exact candidate commit; missing checks are not a success.

Every run takes the fork path: the `build-check-test` job audits every tracked `package-lock.json` at all severities,
including development tools and the private examples' own lockfiles, then restores model data from the upstream npm
`@earendil-works/pi-ai@<packages/coding-agent version>` release (the same frozen input as
`Fork release`), then runs `npm run build:offline`, `npm run check`, the daemon build and
`./test.sh`. `mcp-conformance` runs alongside. No new jobs or matrix are added.
`scripts/fork-dependency-audit.mjs` accepts only exact advisory/package pairs in `scripts/fork-audit-exceptions.json`; expired, stale, malformed and failed audits block CI. Mutual dependency cycles must reach an accepted advisory; unanchored cycles fail.
There are no active exceptions. GitHub withdrew `GHSA-fc5q-39xc-vjpf` on 2026-11-18; its stale `picomatch` exception was removed without changing dependencies or relaxing the audit policy ([#118](https://github.com/nredd/pi/issues/118)).

## Prove a workflow change

Pushing a `fork-release.yml` change to an `automation/**` branch runs the same dry-run against `v1.3.0-nredd.7`. This is required because GitHub indexes `workflow_dispatch` workflows only after they reach the default branch, and does not schedule a workflow newly added to a pull request. After the workflow reaches the default branch, run `Fork release` with `workflow_dispatch` and `release_tag=v1.3.0-nredd.7` (or another existing signed fork tag). Both paths check out that immutable tag, build, pack, and compare the rebuilt tarballs that tag actually published (older tags shipped fewer) with its published assets. Only tag-triggered runs attest and release; dry-runs create neither attestations nor releases.

`v1.3.0-nredd.3` through `v1.3.0-nredd.7` predate this workflow. They are legacy releases: pi-harness permits their explicit recorded SHA-256 values only. Do not backfill an attestation by rerunning a newer workflow because provenance would describe the newer workflow revision, not the historical release build.

## Not automated

The release workflow does not open the cross-repository tap pull request. Unattended tap PRs require a narrowly scoped GitHub App installed in both `nredd/pi` and `nredd/homebrew-tap`; `GITHUB_TOKEN` cannot write to the tap. Bun standalone artifacts remain tracked by `nredd/pi-harness#72`. The separate upstream
`build-binaries.yml` path requires the [tested-byte and pi-memory gates](binary-release-gates.md)
for future binary releases; it does not add standalone assets to `Fork release` or authorize
publication of the frozen `.11` release.
