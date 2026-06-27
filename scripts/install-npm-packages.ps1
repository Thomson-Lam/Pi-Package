$ErrorActionPreference = "Stop"

# Install Pi packages that are published on the npm registry.
# These are Pi package installs, so use `pi install npm:...`, not `npm install`.

$Packages = @(
    "npm:pi-interactive-shell",
    "npm:pi-opencode-bridge",
    "npm:@nerisma/pi-tool-border",
    "npm:@nerisma/pi-turn-usage-notifications",
    "npm:@javargasm/pi-usage-bars"
)

Write-Host "Installing Pi npm packages..."

foreach ($Package in $Packages) {
    Write-Host "Installing $Package"
    pi install $Package
}

Write-Host "Done. Restart Pi or run /reload inside Pi."
