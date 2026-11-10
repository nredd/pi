#!/usr/bin/env bash
# Runs one CI test suite: a single workspace by name, or every other workspace with `other`.
# Fork refs run it through `./test.sh scripts/ci-test-suite.sh <suite>` so tests get an isolated home.
set -euo pipefail

suite="${1:?usage: ci-test-suite.sh <suite>}"

if [[ "$suite" != other ]]; then
	exec npm run test --workspace "packages/$suite"
fi

# Every other workspace, so new packages are tested without editing the workflow.
args=()
for dir in packages/*/; do
	case "$dir" in packages/coding-agent/ | packages/durable/) continue ;; esac
	args+=(--workspace "${dir%/}")
done
npm run test:scripts
npm run test --if-present "${args[@]}"
