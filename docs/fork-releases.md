# Fork releases

`nredd/pi` keeps the upstream package names and releases exactly four tarballs, needed by `nredd/tap` and `nredd/pi-harness`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core` (`packages/agent`) and `@earendil-works/pi-ai`, plus `SHA256SUMS`.

## Cut a release

1. Obtain green PR and pi-harness stack evidence for the exact release commit.
2. Create and push an owner-signed annotated `vX.Y.Z-nredd.N` tag on a commit reachable from `nredd/vX.Y.Z`. CI verifies the SSH signature against the owner's pinned signing key and rejects branches or tag names outside that contract. This is *not* the trust boundary: the workflow executes from the tagged commit, so a writer could tag a commit whose edited workflow skips that check. The creation control is the tag ruleset `Fork release tags` (id `25519508`, [here](https://github.com/nredd/pi/rules/25519508)), which blocks creating, moving or deleting `refs/tags/v*-nredd.*` for everyone except the repository admin role (the owner, the only admin). Inspect with `gh api repos/nredd/pi/rulesets/25519508`; never weaken it from CI.
3. The `Fork release` workflow restores `@earendil-works/pi-ai@X.Y.Z` model data, runs `npm ci --ignore-scripts`, `npm run build:offline`, `npm run check`, builds `packages/env`'s daemon, runs `./test.sh`, then packs `packages/coding-agent`, `packages/tui`, `packages/agent` and `packages/ai`.
4. CI extracts the packed coding-agent bundle and requires `DEFAULT_REASONING_SUMMARY="detailed"` in at least one bundled chunk (the shared default is hoisted into a generic chunk, so this is stronger than grepping only `*responses*.js` for `"detailed"`, but it does not prove every chunk). It writes `SHA256SUMS`, attests all four tarballs with GitHub build provenance, and creates a new GitHub release. Existing releases are never overwritten.
5. Verify the release bytes before changing the tap or dotfiles. `pi-harness` requires the release `SHA256SUMS` and provenance for all post-automation tags. Releases are authenticated by provenance of CI-built bytes, not reproducible rebuilding: dry-run [39502658787](https://github.com/nredd/pi/actions/runs/39502658787) rebuilt `v1.3.0-nredd.7` with different SHA-256 values. Rebuilds will differ; reproducibility is tracked in [nredd/pi-harness#84](https://github.com/nredd/pi-harness/issues/84).

## Pull request CI

`ci.yml` runs on pushes and pull requests to `main` and `nredd/v1.3.0`, plus pushes to
`security/**`. The security-branch push path bootstraps candidate CI before the PR target
contains the new branch trigger; require a real run on the exact candidate commit.

For `main`, upstream behavior stays unchanged: `npm run build` (live model data),
`npm run check`, the `packages/env` daemon build and `npm test`. For the fork branch or
a security-branch push, the same `build-check-test` job audits the full dependency graph
including development tools, restores model data from the upstream npm
`@earendil-works/pi-ai@<packages/coding-agent version>` release (the same frozen input as
`Fork release`), then runs `npm run build:offline`, `npm run check`, the daemon build and
`./test.sh`. `mcp-conformance` runs unchanged on both paths. No new jobs or matrix are added.
A new fork branch (e.g. `nredd/v1.4.0`) must be added to the triggers and `IS_FORK_REF`.

## Prove a workflow change

Pushing a `fork-release.yml` change to an `automation/**` branch runs the same dry-run against `v1.3.0-nredd.7`. This is required because GitHub indexes `workflow_dispatch` workflows only after they reach the default branch, and does not schedule a workflow newly added to a pull request. After the workflow reaches the default branch, run `Fork release` with `workflow_dispatch` and `release_tag=v1.3.0-nredd.7` (or another existing signed fork tag). Both paths check out that immutable tag, build, pack, and compare the rebuilt tarballs that tag actually published (older tags shipped fewer) with its published assets. Only tag-triggered runs attest and release; dry-runs create neither attestations nor releases.

`v1.3.0-nredd.3` through `v1.3.0-nredd.7` predate this workflow. They are legacy releases: pi-harness permits their explicit recorded SHA-256 values only. Do not backfill an attestation by rerunning a newer workflow because provenance would describe the newer workflow revision, not the historical release build.

## Not automated

The release workflow does not open the cross-repository tap pull request. Unattended tap PRs require a narrowly scoped GitHub App installed in both `nredd/pi` and `nredd/homebrew-tap`; `GITHUB_TOKEN` cannot write to the tap. Bun standalone artifacts remain tracked by `nredd/pi-harness#72`.
