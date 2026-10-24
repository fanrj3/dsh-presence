# Presence manual installer.
#
# Run this with the DSH app CLOSED. It performs one deterministic composition
# edit and exits — no live plugin reload, no interrupted install window.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-presence.ps1 -Mode safe
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-presence.ps1 -Mode fs
#
# -Mode safe : tools + remote-workspace panel (never touches ctx.fs)
# -Mode fs   : additionally mounts the presence:// filesystem provider, so a
#              remote folder becomes a real DSH workspace
#
# Undo with scripts\uninstall-presence.ps1 and restart.

param(
  [ValidateSet('safe', 'fs')][string]$Mode = 'safe',
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
if (-not (Test-Path (Join-Path $PluginRoot 'index.js'))) { throw "plugin not found at $PluginRoot" }

if (-not $Force) {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Warning 'DeepSeek Harness is running. Close it completely, then run this script again.'
    throw 'refusing to edit a live profile (use -Force to override)'
  }
}

# 1. Select the bundle patch this mode ships.
$preset = Join-Path $PluginRoot "presets\$Mode.patch.yml"
if (-not (Test-Path $preset)) { throw "missing preset: $preset" }
Copy-Item $preset (Join-Path $PluginRoot 'cordis.patch.yml') -Force

# 2. Add the bundle to the profile composition.
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$linkPath = ('link:' + ($PluginRoot -replace '\\', '/'))

$deps = @{}
if ($pkg.dependencies) { $pkg.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
$deps['dsh-presence'] = $linkPath
$pkg.dependencies = [pscustomobject]$deps

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
if ($bundles -notcontains 'dsh-presence') { $bundles += 'dsh-presence' }
$pkg.dsh.profile.bundles = $bundles

$json = $pkg | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# 3. Link the package into the profile's node_modules (junction: no admin needed).
$nodeModules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null
$link = Join-Path $nodeModules 'dsh-presence'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $PluginRoot | Out-Null

Write-Host ''
Write-Host "Presence installed in mode '$Mode'." -ForegroundColor Green
Write-Host "  plugin : $PluginRoot"
Write-Host "  profile: $profileDir"
Write-Host ''
if ($Mode -eq 'fs') {
  Write-Host 'FS MODE: if new sessions fail with "sessionController is unavailable",' -ForegroundColor Yellow
  Write-Host 'run scripts\uninstall-presence.ps1 and restart. That restores the shipped backend.' -ForegroundColor Yellow
}
Write-Host 'Now start DeepSeek Harness.' -ForegroundColor Green
