# Upstream drift canary

`.github/workflows/upstream-drift.yml` runs daily and on `workflow_dispatch`. It is not a required check and never runs on pull requests.

It fetches `https://github.com/earendil-works/pi.git` (`main`) read-only, then `scripts/upstream-drift.mjs`:

- counts commits behind and ahead, and groups the upstream commits by top-level area
- trial-merges upstream into a scratch worktree with `git merge --no-commit` and lists conflicted paths
- lists upstream commits touching files the fork patch stack changed (`git diff --name-only <merge-base> <fork>`)
- lists `### Breaking Changes` entries in `packages/*/CHANGELOG.md` that are not at the merge base

Two hosted-runner jobs (`ubuntu-latest`, never self-hosted) keep the issue token and the runner away from upstream code:

- `trial`: `permissions: contents: read` only, no `issues` scope, no `GITHUB_TOKEN` in any step env, no `cache:` or `actions/cache` step. The host side only runs `git`, `jq` and trusted scripts from our own checkout: the fetch, `analyze` (git only, it never executes a file from the merged tree), `pack`, and the artifact upload. Every step that EXECUTES upstream code (install, release model data restore, build, check, daemon build, tests) goes through `scripts/upstream-drift-sandbox.sh`
- the sandbox: `docker run --rm` of an image built from `scripts/upstream-drift.Dockerfile` (base images pinned by digest, built from stdin so no upstream file is in the build context) with all capabilities dropped, `no-new-privileges`, the host uid, its own PID namespace, no `sudo`, no Docker socket, exactly one bind mount (the merged tree at `/work`) a `--pids-limit`, and three environment variables passed from the host (`HOME`, `CARGO_HOME`, `CI`) on top of the image's own `ENV` (`PATH`, `RUSTUP_HOME`, Node image vars), none secret. Why: a hosted runner gives passwordless `sudo`, and code running directly on the host can read the `Runner.Worker` process (its cache and artifact tokens), which would let it write main-scope Actions caches that `ci.yml` and release jobs restore (the published "Cacheract" technique). Inside the container none of that is visible. Not isolated: the network stays on (npm and crates.io need it, so cloud metadata endpoints are also reachable), there is no memory or CPU cap (step timeouts are the only bound), and the tree is mounted read-write, so upstream code can change the scratch tree (that only affects the trial). The artifact is the only thing the job hands on, and it is untrusted by `report`
- `report`: `needs: trial`, runs only on the default branch (`always()` so a failed trial still reports), `issues: write`, fresh runner, checks out the exact fork sha the trial tested. It never installs, builds or runs upstream code. It schema-validates the artifact (exact keys, 40 hex `upstreamSha` and `localSha`, outcomes from a fixed set, conflict paths length and count capped, no control characters), fetches `upstream main`, requires the tested upstream sha to be an ancestor of that tip (a bare sha can name a commit from any fork), requires the tested `localSha` to equal the checked out HEAD (else the run fails as stale), and regenerates counts, areas, commit subjects, patched-file overlap and breaking entries from git at the tested shas. Only the shas, conflicted paths and step outcomes come from the artifact. An invalid artifact, non-ancestor sha or stale `localSha` fails the job and updates nothing; a missing artifact still reports the git facts at the tip with the trial marked "not attempted". A `workflow_dispatch` from a non-default ref runs `trial` but skips `report`

Every upstream-controlled string (subjects, paths, changelog text, versions) is rendered as a code span with backticks stripped and a zero-width space after `@`, `#` and `<`, so it cannot ping users, link issues or forge the state marker. The state parser also takes only the LAST marker and requires it at the end of the body.

When the merge is clean the `trial` job also mirrors `ci.yml` in the sandbox: the sandbox image build (a failure there makes the trial inconclusive, not red), `npm ci --ignore-scripts`, release model data restore, `npm run build:offline`, `npm run check`, the `pi-env` daemon build and `./test.sh` (minus the dependency audit). Each step has its own timeout and the job is capped at 120 minutes.

Results go to ONE rolling issue labelled `upstream-drift`. Each run rewrites the body; a comment is posted only for a trip that was not tripped on the previous run. Trips:

- behind more than 200 commits
- any trial merge conflict
- any trial step red on a clean merge (inconclusive when system deps failed)
- a new breaking change entry

State for "new trip" and "since last run" lives in an HTML comment at the end of the issue body. Closing the issue makes the next run open a fresh one (and re-comment its trips once). A failed `report` job (git error, invalid artifact, non-ancestor sha, stale `localSha`) updates nothing; the red Actions run is the signal. A failed `trial` job (no artifact) still updates the issue with the git facts and "Trial merge: not attempted", and carries any standing `conflicts` or `trial` trip forward so it neither clears nor re-comments. Only the two `gh` steps of `report` hold the token.

Run it locally:

```
git fetch upstream main
node scripts/upstream-drift.mjs analyze --local-ref origin/main --upstream-ref upstream/main --trial-dir /tmp/trial --out /tmp/report.json
echo '{"deps":"success","install":"success","models":"success","build":"success","check":"success","daemon":"success","test":"success"}' > /tmp/trial.json
node scripts/upstream-drift.mjs pack --report /tmp/report.json --trial /tmp/trial.json --out /tmp/artifact.json
node scripts/upstream-drift.mjs finalize --local-ref origin/main --upstream-ref upstream/main --artifact /tmp/artifact.json --body-out /tmp/body.md --comment-out /tmp/comment.md
```

Bumping the sandbox: the two base images are pinned by digest in `scripts/upstream-drift.Dockerfile` and have no Dependabot path, so refresh them by hand (`docker buildx imagetools inspect <image>`) when the toolchain goes stale.

Tests: `node --test scripts/upstream-drift.test.mjs`.
