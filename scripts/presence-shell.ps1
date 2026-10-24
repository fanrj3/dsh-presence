# Presence remote-terminal launcher.
#
# DSH's built-in terminal panel spawns a LOCAL shell with cwd = the session's
# working directory. Inside a Presence remote workspace that cwd is the mount
# marker (C:\Users\<you>\.dsh\presence\mounts\<host>\<remote path>), an empty
# local directory. This launcher turns that panel into a real remote shell:
#
#   cwd under the mounts root  ->  ssh -t <host> "cd '<remote path>' && exec $SHELL -l"
#   cwd anywhere else          ->  the ordinary local shell
#
# It is embedded (UTF-16LE base64, -EncodedCommand) into cordis.patch.yml as the
# terminal-controller default shell, so no absolute paths or installer steps are
# needed. Source of truth: this file; regenerate with scripts/embed-shell.mjs.
#
# Dry run for tests: set PRESENCE_SHELL_DRY=1 to print what would happen.

$ErrorActionPreference = 'SilentlyContinue'

function Get-PresenceMountsRoot {
  if ($env:DSH_HOME) { return (Join-Path $env:DSH_HOME 'presence\mounts') }
  $base = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  return (Join-Path $base '.dsh\presence\mounts')
}

# POSIX single-quote escaping for the remote shell.
function ConvertTo-ShQuoted([string]$value) {
  return "'" + ($value -replace "'", "'\''") + "'"
}

$mountsRoot = (Get-PresenceMountsRoot).TrimEnd('\')
$cwd = (Get-Location).Path

$underMounts = $cwd.StartsWith($mountsRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)

if (-not $underMounts) {
  if ($env:PRESENCE_SHELL_DRY) { Write-Output 'LOCAL' }
  else {
    & $env:ComSpec
    exit $LASTEXITCODE
  }
  exit 0
}

$relative = $cwd.Substring($mountsRoot.Length).TrimStart('\')
$segments = $relative -split '\\'
$hostAlias = $segments[0]
$tail = @($segments | Select-Object -Skip 1) -join '/'
$remotePath = ('/' + $tail).TrimEnd('/')
if ([string]::IsNullOrEmpty($remotePath)) { $remotePath = '/' }

$remoteCommand = 'cd ' + (ConvertTo-ShQuoted $remotePath) + ' && exec "${SHELL:-/bin/bash}" -l'

if ($env:PRESENCE_SHELL_DRY) {
  Write-Output "HOST=$hostAlias"
  Write-Output "REMOTE=$remotePath"
  Write-Output "CMD=$remoteCommand"
  exit 0
}

& ssh -t $hostAlias $remoteCommand
exit $LASTEXITCODE
