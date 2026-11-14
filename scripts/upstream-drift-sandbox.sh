#!/usr/bin/env bash
# Run one shell command against an UNTRUSTED tree inside the sandbox image built from
# `upstream-drift.Dockerfile`. Usage: upstream-drift-sandbox.sh TREE COMMAND
#
# Isolation: unprivileged (all capabilities dropped, no-new-privileges, host uid), own PID
# namespace, exactly one bind mount (TREE at /work), and an explicit three-variable environment.
# Nothing from the runner environment is forwarded. Network stays on for npm and crates.io.
# COMMAND must be a trusted literal from the workflow, never text derived from upstream.
set -euo pipefail

tree="${1:?usage: upstream-drift-sandbox.sh TREE COMMAND}"
command="${2:?usage: upstream-drift-sandbox.sh TREE COMMAND}"

# A relative path would become a named volume and a colon would change option parsing.
case "$tree" in
	/*) ;;
	*) echo "TREE must be an absolute path" >&2; exit 2 ;;
esac
case "$tree" in
	*:*) echo "TREE must not contain a colon" >&2; exit 2 ;;
esac

exec docker run --rm --init \
	--cap-drop=ALL --security-opt=no-new-privileges --pids-limit=4096 \
	--user "$(id -u):$(id -g)" \
	-v "$tree:/work" -w /work \
	-e HOME=/tmp/home -e CARGO_HOME=/tmp/cargo -e CI=true \
	upstream-drift-trial \
	bash -euo pipefail -c "mkdir -p \"\$HOME\" && $command"
