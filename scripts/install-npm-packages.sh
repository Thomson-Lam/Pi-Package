#!/usr/bin/env bash
set -euo pipefail

# Install Pi packages that are published on the npm registry.
# These are Pi package installs, so use `pi install npm:...`, not `npm install`.

PACKAGES=(
  "npm:pi-interactive-shell"
  "npm:pi-opencode-bridge"
  "npm:@nerisma/pi-tool-border"
  "npm:@nerisma/pi-turn-usage-notifications"
  "npm:@javargasm/pi-usage-bars"
)

echo "Installing Pi npm packages..."

for package in "${PACKAGES[@]}"; do
  echo "Installing ${package}"
  pi install "${package}"
done

echo "Done. Restart Pi or run /reload inside Pi."
