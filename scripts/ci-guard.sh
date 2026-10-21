#!/usr/bin/env bash
# Fails the build if any workflow references the secrets context, requests an
# OIDC token or uses the privileged pull-request trigger (prebutton spec D-024).
# Prints file:line:text for each match. Matching ignores case, because GitHub
# expression contexts do. This script lives outside the scanned directory so it
# never matches itself.
#
# Usage: scripts/ci-guard.sh [dir]   (default .github/workflows)
# Exits 0 when clean, 1 on any match, 2 when dir is not a directory.
set -euo pipefail

[ "$#" -le 1 ] || { echo "Usage: scripts/ci-guard.sh [dir]" >&2; exit 2; }
dir="${1:-.github/workflows}"
[ -d "$dir" ] || { echo "ci-guard: not a directory: $dir" >&2; exit 2; }

status=0
grep -rnHiF --include='*.yml' --include='*.yaml' \
  -e 'secrets.' -e 'id-token' -e 'pull_request_target' "$dir" || status=$?

case "$status" in
  0) echo "ci-guard: forbidden workflow content above (D-024)" >&2; exit 1 ;;
  1) exit 0 ;;
  *) exit 2 ;;
esac
