# Build dist/presence-plugin-<version>.zip from the repository.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1 -Version 0.7.2
#
# Works on Windows PowerShell 5.1 (no pwsh 7 required). The zip bundles
# node_modules on purpose: a DSH bundle is installed as a directory, and ssh2
# must resolve from inside it. Git ignores node_modules; run `npm install` once
# after cloning before packaging.

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$KeepOld
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.pack\presence'
$dist = Join-Path $root 'dist'

Write-Host "packaging Presence $Version from $root"

# Fail fast on a syntax error rather than shipping a broken bundle.
$sources = @('index.js', 'client.js') + (Get-ChildItem (Join-Path $root 'src') -Recurse -File -Include *.js, *.mjs | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
foreach ($source in $sources) {
  node --check (Join-Path $root $source)
  if ($LASTEXITCODE -ne 0) { throw "syntax error in $source" }
}

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($item in @('index.js', 'client.js', 'package.json', 'icon.svg', 'README.md', 'INSTALL.md', 'locale', 'src', 'presets', 'docs', 'node_modules', 'scripts')) {
  $path = Join-Path $root $item
  if (Test-Path $path) { Copy-Item $path $stage -Recurse -Force }
}
# Relative-path probes are development-only; the absolute verifiers ship.
Get-ChildItem (Join-Path $stage 'scripts') -Filter 'isolated-check.mjs' -ErrorAction SilentlyContinue | Remove-Item -Force
# Default install mode: the safe patch (no fs swap).
Copy-Item (Join-Path $root 'presets\safe.patch.yml') (Join-Path $stage 'cordis.patch.yml') -Force

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "presence-plugin-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force (Join-Path $root '.pack')

if (-not $KeepOld) {
  Get-ChildItem $dist -Filter 'presence-plugin-*.zip' | Where-Object { $_.FullName -ne $zip } | Remove-Item -Force
}
'{0:N2} MB  {1}' -f ((Get-Item $zip).Length / 1MB), $zip
