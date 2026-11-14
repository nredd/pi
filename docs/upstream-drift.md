# Upstream drift canary

`.github/workflows/upstream-drift.yml` runs daily and on `workflow_dispatch`. It is not a required check and never runs on pull requests.

It fetches `https://github.com/earendil-works/pi.git` (`main`) read-only, then `scripts/upstream-drift.mjs`:

- counts commits behind and ahead, and groups the upstream commits by top-level area
- trial-merges upstream into a scratch worktree with `git merge --no-commit` and lists conflicted paths
- lists upstream commits touching files the fork patch stack changed (`git diff --name-only <merge-base> <fork>`)
- lists `### Breaking Changes` entries in `packages/*/CHANGELOG.md` that are not at the merge base

Two hosted-runner jobs (`ubuntu-latest`, never self-hosted) keep the issue token away from upstream code:

- `trial`: `permissions: contents: read` only. Runs `analyze` and the trial below, packs the sha, conflicted paths and step outcomes into a small JSON artifact. No `issues` scope, no token in the env, no cache of any kind (no `setup-node` `cache:`, no `actions/cache`), so it cannot poison caches used by `ci.yml`
- `report`: `needs: trial`, `if: always()`, `issues: write`, fresh runner, our `main` only. It never installs, builds or runs upstream code. It schema-validates the artifact (exact keys, 40 hex sha, outcomes from a fixed set, conflict paths length and count capped, no control characters), fetches upstream refs pinned to the tested sha, and regenerates counts, areas, commit subjects, patched-file overlap and breaking entries from git. Only the sha, conflicted paths and step outcomes come from the artifact. An invalid artifact or a sha mismatch fails the job and updates nothing; a missing artifact still reports the git facts with the trial marked "not attempted"

Every upstream-controlled string (subjects, paths, changelog text, versions) is rendered as a code span with backticks stripped and a zero-width space after `@`, `#` and `<`, so it cannot ping users, link issues or forge the state marker. The state parser also takes only the LAST marker and requires it at the end of the body.

When the merge is clean the `trial` job also mirrors `ci.yml` in the scratch tree: system deps (an apt failure makes the trial inconclusive, not red), `npm ci --ignore-scripts`, release model data restore, `npm run build:offline`, `npm run check`, the `pi-env` daemon build and `./test.sh` (minus the dependency audit). Each step has its own timeout and the job is capped at 120 minutes.

Results go to ONE rolling issue labelled `upstream-drift`. Each run rewrites the body; a comment is posted only for a trip that was not tripped on the previous run. Trips:

- behind more than 200 commits
- any trial merge conflict
- any trial step red on a clean merge (inconclusive when system deps failed)
- a new breaking change entry

State for "new trip" and "since last run" lives in an HTML comment at the end of the issue body. Closing the issue makes the next run open a fresh one (and re-comment its trips once). A failed `report` job (git error, invalid artifact, sha mismatch) updates nothing; the red Actions run is the signal. A failed `trial` job (no artifact) still updates the issue with the git facts and "Trial merge: not attempted", and carries any standing `conflicts` or `trial` trip forward so it neither clears nor re-comments. The `report` job checks out the default branch, even for a `workflow_dispatch` from another ref, and only the two `gh` steps hold the token.

Run it locally:

```
git fetch upstream main
node scripts/upstream-drift.mjs analyze --local-ref origin/main --upstream-ref upstream/main --trial-dir /tmp/trial --out /tmp/report.json
echo '{"deps":"success","install":"success","models":"success","build":"success","check":"success","daemon":"success","test":"success"}' > /tmp/trial.json
node scripts/upstream-drift.mjs pack --report /tmp/report.json --trial /tmp/trial.json --out /tmp/artifact.json
node scripts/upstream-drift.mjs finalize --local-ref origin/main --upstream-ref upstream/main --artifact /tmp/artifact.json --body-out /tmp/body.md --comment-out /tmp/comment.md
```

Tests: `node --test scripts/upstream-drift.test.mjs`.
