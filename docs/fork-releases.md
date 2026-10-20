# Fork releases

`nredd/pi` keeps the upstream package names and releases only the coding-agent and TUI tarballs needed by `nredd/tap` and `nredd/pi-harness`.

## Cut a release

1. Obtain green PR and pi-harness stack evidence for the exact release commit.
2. Create and push an owner-signed annotated `vX.Y.Z-nredd.N` tag on a commit reachable from `nredd/vX.Y.Z`. CI verifies the SSH signature against the owner's pinned signing key and rejects branches or tag names outside that contract.
3. The `Fork release` workflow restores `@earendil-works/pi-ai@X.Y.Z` model data, runs `npm ci --ignore-scripts`, `npm run build:offline`, `npm run check`, builds `packages/env`'s daemon, runs `./test.sh`, then packs `packages/coding-agent` and `packages/tui`.
4. CI extracts the packed coding-agent bundle and requires the Responses `"detailed"` default. It writes `SHA256SUMS`, attests both tarballs with GitHub build provenance, and creates a new GitHub release. Existing releases are never overwritten.
5. Verify the release bytes before changing the tap or dotfiles. `pi-harness` requires the release `SHA256SUMS` and provenance for all post-automation tags.

## Prove a workflow change

A pull request changing `fork-release.yml` automatically runs the same dry-run against `v1.3.0-nredd.7`. This is required because GitHub indexes `workflow_dispatch` workflows only after they reach the default branch, so it cannot dispatch a new workflow file from its first PR branch. After the workflow reaches the default branch, run `Fork release` with `workflow_dispatch` and `release_tag=v1.3.0-nredd.7` (or another existing signed fork tag). Both paths check out that immutable tag, build, pack, and attest it, download the existing tarballs, and fail unless their SHA-256 values are byte-identical. Neither creates or changes a GitHub release.

`v1.3.0-nredd.6` and `v1.3.0-nredd.7` predate this workflow. They are legacy releases: pi-harness permits their recorded SHA-256 values only. Do not backfill an attestation by rerunning a newer workflow because provenance would describe the newer workflow revision, not the historical release build.

## Not automated

The release workflow does not open the cross-repository tap pull request. Unattended tap PRs require a narrowly scoped GitHub App installed in both `nredd/pi` and `nredd/homebrew-tap`; `GITHUB_TOKEN` cannot write to the tap. Bun standalone artifacts remain tracked by `nredd/pi-harness#72`.
