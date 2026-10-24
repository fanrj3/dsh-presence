# Presence manual uninstaller.
#
# Run with the DSH app CLOSED. Removes the bundle row, the dependency and the
# node_modules junction, and restores the safe patch. A restart then composes the
# profile exactly as it was before Presence.

param(
  [string]$Profile = 'desktop',
  [string]$PluginRoot = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not $PluginRoot) { $PluginRoot = Split-Path -Parent $PSScriptRoot }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgPath)) { throw "profile not found: $pkgPath" }

if (-not $Force) {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Warning 'DeepSeek Harness is running. Close it completely, then run this script again.'
    throw 'refusing to edit a live profile (use -Force to override)'
  }
}

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json

$deps = @{}
if ($pkg.dependencies) { $pkg.dependencies.PSObject.Properties | ForEach-Object { if ($_.Name -ne 'dsh-presence') { $deps[$_.Name] = $_.Value } } }
$pkg.dependencies = [pscustomobject]$deps

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-presence' }) }
$pkg.dsh.profile.bundles = $bundles

$json = $pkg | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$link = Join-Path $profileDir 'node_modules\dsh-presence'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }

# Leave the checkout in safe mode so a later install cannot surprise anyone.
$safe = Join-Path $PluginRoot 'presets\safe.patch.yml'
if (Test-Path $safe) { Copy-Item $safe (Join-Path $PluginRoot 'cordis.patch.yml') -Force }

Write-Host ''
Write-Host 'Presence removed from the profile.' -ForegroundColor Green
Write-Host 'Start DeepSeek Harness: the shipped filesystem backend is back.' -ForegroundColor Green
