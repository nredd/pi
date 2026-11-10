# Security dependency assessment

Review date: 2026-10-26. Scope: [nredd/pi#10](https://github.com/nredd/pi/pull/10), the maintained `nredd/v1.3.0` fork.

The release-note review was completed during PR review, after the initial dependency update and before merge or tagging.

## Undici 8.10.2 -> 8.12.3

The reviewed release notes are [8.11.0](https://github.com/nodejs/undici/releases/tag/v8.11.0), [8.11.1](https://github.com/nodejs/undici/releases/tag/v8.11.1), [8.11.2](https://github.com/nodejs/undici/releases/tag/v8.11.2), [8.12.0](https://github.com/nodejs/undici/releases/tag/v8.12.0), [8.12.1](https://github.com/nodejs/undici/releases/tag/v8.12.1), [8.12.2](https://github.com/nodejs/undici/releases/tag/v8.12.2), and [8.12.3](https://github.com/nodejs/undici/releases/tag/v8.12.3).

`8.12.2` fixes the reported excess-content-encoding crash (`GHSA-xjj6-f33q-929c`), mixed-case SRI algorithm bypass (`GHSA-f72v-6w45-q472`), and unbounded EventSource parser state (`GHSA-4qv8-2p9j-2685`). `8.12.3` also fixes Pool async-context preservation and an HTTP/2 timeout recovery path.

The core caller is [`http-dispatcher.ts`](../packages/coding-agent/src/core/http-dispatcher.ts). It constructs `EnvHttpProxyAgent`, `Client`, and `Pool`, sets the global dispatcher, and installs the matching fetch implementation unless a caller deliberately replaced fetch. Its options and error listener are unchanged by this update.

Compatibility assessment:

- `8.11.0` changes `NO_PROXY` wildcard handling; `8.12.0` changes proxy Host-header handling. Custom proxy exclusions can therefore route differently. The existing CONNECT-tunnel and TCP-attempt-timeout tests cover the core's explicit configuration, not every enterprise proxy policy. Validate machine-specific proxy settings before deployment there.
- The intermediate releases change decompression and response handling. The new isolated compression fixture exercises gzip and brotli JSON through both `undici.fetch` and the installed `globalThis.fetch`, using the real core dispatcher. This protects the Node/native-fetch compatibility workaround without removing it.
- A separate child-process fixture sends six content encodings, a promised body, and an early FIN. Both fetch paths must reject and the process must exit normally after cleanup. The same probe against `8.10.2` exits with an unhandled `UND_ERR_SOCKET`; `8.12.3` exits successfully. No uncaught-exception handler masks the failure.
- The core uses `allowH2: false`, so HTTP/2 fixes are unlikely to affect its normal path. This is an inference from the configuration, not an HTTP/2 runtime proof.
- No reviewed release note removes or renames an option used by this caller. This does not establish that every provider SDK avoids EventSource, SRI, or WebSocket APIs.

The fixtures and their child-process assertions are in [`http-dispatcher-upgrade.test.ts`](../packages/coding-agent/test/http-dispatcher-upgrade.test.ts). They use loopback servers, not provider credentials or external model requests.

## Remaining dependency graph

- The explicitly approved removal deletes the optional `sandbox/` example, its workspace, its exclusive runtime dependency, and the obsolete audit exception. Pi never enabled that example by default. Built-in execution and the separate Gondolin example remain.
- Gondolin moves from `0.12.0` to `0.14.0`. Its [published metadata](https://registry.npmjs.org/@earendil-works/gondolin/0.14.0) declares Node `>=22.19.0` and `undici ^6.29.0`; the locks resolve its separate undici copy to `6.29.1`. The resolved graph no longer contains `node-forge`. The example header now matches the declared Node floor. A real Gondolin VM was not exercised.
- Vitest is pinned to `4.1.12`; compatible lock resolutions include Vite `8.3.5`, fast-uri `3.1.9`, and Zod `4.6.7`. No forced overrides or new audit allowances are introduced.

Audit results are bounded to the candidate's tracked lockfiles, including development dependencies. They are not a claim about historical tags or the still-installed older core. Native checks, hosted CI on the exact candidate, and the signed fork-release process remain release requirements; missing CI is not a passing gate.
