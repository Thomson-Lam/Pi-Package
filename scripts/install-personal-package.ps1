param(
    [string]$Ref = $env:PI_PACKAGE_REF,
    [string]$Source = $env:PI_PACKAGE_SOURCE
)

$ErrorActionPreference = "Stop"

# Install this personal Pi package from GitHub at a reproducible tag.
# Usage:
#   .\scripts\install-personal-package.ps1 v0.1.3
#
# Optional environment variables:
#   $env:PI_PACKAGE_REF = "v0.1.3"
#   $env:PI_PACKAGE_SOURCE = "git:git@github.com:Thomson-Lam/Pi-Package.git"

if ([string]::IsNullOrWhiteSpace($Ref)) {
    $Ref = "v0.1.3"
}

if ([string]::IsNullOrWhiteSpace($Source)) {
    $Source = "git:github.com/Thomson-Lam/Pi-Package.git"
}

$Spec = "$Source@$Ref"

Write-Host "Installing personal Pi package: $Spec"
pi install $Spec

Write-Host "Done. Restart Pi or run /reload inside Pi."
