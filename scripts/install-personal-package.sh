#!/usr/bin/env bash
set -euo pipefail

# Install this personal Pi package from GitHub at a reproducible tag.
# Usage:
#   ./scripts/install-personal-package.sh v0.1.3
#
# Optional environment variables:
#   PI_PACKAGE_REF=v0.1.3 ./scripts/install-personal-package.sh
#   PI_PACKAGE_SOURCE='git:git@github.com:Thomson-Lam/Pi-Package.git' ./scripts/install-personal-package.sh v0.1.3

REF="${1:-${PI_PACKAGE_REF:-v0.1.3}}"
SOURCE="${PI_PACKAGE_SOURCE:-git:github.com/Thomson-Lam/Pi-Package.git}"

SPEC="${SOURCE}@${REF}"

echo "Installing personal Pi package: ${SPEC}"
pi install "${SPEC}"

echo "Done. Restart Pi or run /reload inside Pi."
