# Upstream drift canary

`.github/workflows/upstream-drift.yml` runs daily and on `workflow_dispatch`. It is not a required check and never runs on pull requests.

It fetches `https://github.com/earendil-works/pi.git` (`main`) read-only, then `scripts/upstream-drift.mjs`:

- counts commits behind and ahead, and groups the upstream commits by top-level area
- trial-merges upstream into a scratch worktree with `git merge --no-commit` and lists conflicted paths
- lists upstream commits touching files the fork patch stack changed (`git diff --name-only <merge-base> <fork>`)
- lists `### Breaking Changes` entries in `packages/*/CHANGELOG.md` that are not at the merge base

When the merge is clean the workflow also mirrors `ci.yml` in the scratch tree: system deps, `npm ci --ignore-scripts`, release model data restore, `npm run build:offline`, `npm run check`, the `pi-env` daemon build and `./test.sh` (minus the dependency audit). Each step has its own timeout and the job is capped at 100 minutes.

Results go to ONE rolling issue labelled `upstream-drift`. Each run rewrites the body; a comment is posted only for a trip that was not tripped on the previous run. Trips:

- behind more than 200 commits
- any trial merge conflict
- any trial step red on a clean merge
- a new breaking change entry

State for "new trip" and "since last run" lives in an HTML comment at the end of the issue body. Closing the issue makes the next run open a fresh one (and re-comment its trips once). A failed run (git error, merge failure without conflicts) updates nothing; the red Actions run is the signal.

Run it locally:

```
git fetch upstream main
node scripts/upstream-drift.mjs analyze --local-ref origin/main --upstream-ref upstream/main --trial-dir /tmp/trial --out /tmp/report.json
node scripts/upstream-drift.mjs finalize --report /tmp/report.json --body-out /tmp/body.md --comment-out /tmp/comment.md
```

Tests: `node --test scripts/upstream-drift.test.mjs`.
