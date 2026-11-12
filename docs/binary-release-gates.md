# Tested-byte binary release gates

`build-binaries.yml` previously admitted archives after help/version/codemode smoke without
loading the extension that exposed nredd/pi-harness#72. A new checksum of replacement bytes
is not evidence those bytes passed any test. Core #43 adds admission for future binary
releases, not a Type3 fix, a release authorization or closure of harness #72.

## Artifact path

1. Build once from the source archive. Record schema-version 1 `BUILD-IDENTITY.json`:
   exact checkout SHA, requested release tag, observed Bun version, and archive/executable
   SHA-256 for all six architectures. Preserve this manifest independently as the current
   run's immutable `binary-build-identity` Actions artifact.
2. Each native smoke runner downloads the **same** built archives. Existing help/version/
   codemode smoke remains. Memory smoke extracts the archive afresh, checks its own native
   platform, and exercises the extracted executable. There is no rebuild between testing,
   staging and publication. Each architecture requires its own successful receipt; runner
   unavailability blocks release rather than silently admitting an untested architecture.
3. Download pinned public `pi-memory@0.4.2` bytes from the URL and SHA-512 SRI versioned in
   `scripts/binary-release-contract.mjs`. Verify SRI before extracting its genuine npm
   package. This version has only Pi peer dependencies, supplied by the CLI host, so no
   dependency installation, lifecycle scripts, global install or user's npm config is needed.
4. Run the actual CLI with that extension, a private HOME/auth/settings/memory directory and
   a credential-free environment. A local OpenAI-compatible SSE server requests real
   `memory_write`, then `memory_read`, verifies their returned content and the real memory
   file, and replies with a strict marker. Missing tools, startup warnings, nonzero exit,
   extra requests, wrong contents or timeout fail. User provider credentials/configuration
   are not inherited; the selected provider is loopback-only with a synthetic API key.
   This is not a subprocess/network sandbox against malicious reviewed extension code.
5. After smoke, rehash both archive and executable; only unchanged bytes get schema-version 1
   `smoke-<platform>.json`. Each immutable `binary-smoke-<platform>` Actions artifact binds
   source SHA, release tag, platform, both digests and exact memory package identity/success.
6. Stage only after all six receipts match the original build identity and current archives.
   Publish the original manifest and combined `BINARY-SMOKE.json` alongside archives and
   `SHA256SUMS`. The final publication job re-downloads the actual draft assets and checks
   them against the **original current-run Actions evidence**, not just JSON/checksums in
   the mutable draft. Replacing archives and regenerating all draft metadata still fails.
   Existing npm/announcement ordering and failed-draft cleanup remain unchanged.

The source SHA is the exact `SOURCE_REF` checkout, including an explicitly requested recovery
ref. Staging/publication checkouts must agree; moving the ref fails admission. Receipts are
workflow evidence inside the repository's reviewed-source/current-run trust boundary, not
new signed external attestations. A writer who can replace the workflow or its trusted build
job can change the checks; this is not a defense against that authority. Existing fork tag
protections and npm provenance policy are not replaced or weakened.

## Compiler boundary

The binary workflow keeps Bun `1.3.14`. Its pin descends from upstream `228d29b84`, whose
stated reason was `BUN_CONFIG_HTTP_IDLE_TIMEOUT` support. The fork's frozen base predates
upstream `906e1302f` (later general 1.4.4 binary validation), while harness #197 independently
selected `1.4.4` for its collector/test toolchain. Neither that difference nor upstream's
local smoke establishes the Type3 cause. No compiler bump, bundler workaround or historical
~330-clean-run claim is part of this change.

Frozen `v1.3.0-nredd.11` / `640d64bcd4da08231232b5c08acd48b88ee1fd45` remains unchanged.
`fork-release.yml` still publishes only four npm tarballs plus `SHA256SUMS`, not standalone
archives. This source PR does not tag, build/rebuild a release, publish, change #775/pins,
activate the user's installation, or authorize a standalone release. No binary build fleet
is run for the source PR; future native smoke must execute before actual binary admission.

## Checks

```sh
npm run check:binary-release
node --test scripts/binary-release-contract.test.mjs scripts/binary-release-workflow.test.mjs scripts/smoke-test-memory-binary.test.mjs
actionlint .github/workflows/build-binaries.yml
# Explicit bounded real-CLI developer proof, using an existing built CLI, no binary build:
node scripts/smoke-test-memory-binary.mjs --cli /absolute/path/to/dist/cli.js
```

The developer CLI proof loads genuine published memory and exercises real tools but emits
**no release receipt**. It does not prove a compiled standalone or any other architecture.
Contract fixtures use small synthetic files to cover failures without compiling binaries;
they are not represented as installed memory or runtime evidence. The negative CLI fixture
printing the success marker alone is refused because no real tool/API exchange occurred.
All contract tests run in the existing scripts suite; `npm run check` includes their strict
JavaScript type check, and Biome owns all new scripts.
