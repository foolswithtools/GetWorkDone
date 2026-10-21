#!/usr/bin/env bash
# Applies the program's branch protection to main (prebutton spec D-021): the
# `ci` check is required and up to date, one approving CODEOWNER review, admins
# included, no force pushes or deletions. A new push dismisses earlier
# approvals, and the last push must be approved by someone other than its
# pusher (D-080).
#
# Usage: scripts/branch-protection.sh <owner/repo>
# Needs gh authenticated with admin rights on the repo; the owner runs it.
set -euo pipefail

usage() {
  echo "Usage: scripts/branch-protection.sh <owner/repo>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
repo="$1"
case "$repo" in
  */*) ;;
  *) usage ;;
esac

body='{"required_status_checks":{"strict":true,"contexts":["ci"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":1,"require_code_owner_reviews":true,"dismiss_stale_reviews":true,"require_last_push_approval":true},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}'

printf '%s\n' "$body" | gh api -X PUT "repos/$repo/branches/main/protection" \
  -H "Accept: application/vnd.github+json" --input -
