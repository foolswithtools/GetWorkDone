#!/usr/bin/env bash
# Installs pnpm from its registry tarball after checking the tarball against an sha512 committed here
# (#51). `npm install --global pnpm@<version>` checks the tarball only against the registry's own
# metadata, so a registry-side substitution would pass; this check would not. Corepack stays out:
# its bundled signing keys can be stale (ci.yml).
#
#   bash scripts/install-pnpm.sh [<version> <sha512>]
#
# Callers (ci.yml, deploy.yml, Dockerfile, README.md) pass nothing; the arguments are for the tests. The
# version must match package.json's packageManager (tests/workflows/ci-guards.test.ts). To move pnpm,
# change both and take the new integrity from the registry once: npm view pnpm@<version> dist.integrity
set -euo pipefail

default_version=10.32.1
default_integrity=sha512-pwaTjw6JrBRWtlY+q07fHR+vM2jRGR/FxZeQ6W3JGORFarLmfWE94QQ9LoyB+HMD5rQNT/7KnfFe8a1Wc0jyvg==

version="${1:-$default_version}"
integrity="${2:-$default_integrity}"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::install-pnpm: '$version' is not a pnpm version" >&2
  exit 1
fi
if ! [[ "$integrity" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]]; then
  echo "::error::install-pnpm: '$integrity' is not an sha512 integrity string (sha512-<base64>)" >&2
  exit 1
fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
tarball="$dir/pnpm-$version.tgz"
curl --fail --silent --show-error --location --retry 3 -o "$tarball" "https://registry.npmjs.org/pnpm/-/pnpm-$version.tgz"

actual="sha512-$(node -e 'process.stdout.write(require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$tarball")"
if [ "$actual" != "$integrity" ]; then
  echo "::error::install-pnpm: pnpm-$version.tgz is $actual, expected $integrity; not installing" >&2
  exit 1
fi

npm install --global "$tarball"
