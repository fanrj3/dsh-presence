# One-command OpenCode end-to-end test for Presence MCP.
#
# Run in a NORMAL PowerShell (outside the DSH sandbox). The DSH sandbox blocks
# opencode's internal uv_spawn calls (git discovery / MCP child process), so this
# script is meant for a plain terminal.
#
#   cd <repo>
#   powershell -NoProfile -ExecutionPolicy Bypass -File mcp/test/opencode-e2e.ps1
#   powershell ... -File mcp/test/opencode-e2e.ps1 -HostAlias server -Model "deepseek/deepseek-chat"
#
# It creates .scratch/opencode-e2e/ with a project config that registers this MCP
# server, then asks OpenCode three questions and checks that the Presence tools
# were actually used.

param(
  [string]$HostAlias = 'server',
  [string]$RemoteDir = '/srv/app',
  [string]$Model = 'opencode-go/deepseek-v4.1-flash',
  [string]$ProjectDir = ''
)

$ErrorActionPreference = 'Stop'
# Native tools (opencode) write progress to stderr; with Stop that would abort the script.
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$server = Join-Path $repo 'mcp\server.mjs'
if (-not (Test-Path $server)) { throw "server not found: $server" }

if (-not $ProjectDir) { $ProjectDir = Join-Path $repo '.scratch\opencode-e2e' }
New-Item -ItemType Directory -Force -Path $ProjectDir | Out-Null

$config = @{
  '$schema' = 'https://opencode.ai/config.json'
  mcp = @{
    servers = @{
      presence = @{
        type = 'local'
        command = @('node', $server)
        cwd = $repo
        environment = @{
          PRESENCE_HOST = $HostAlias
          PRESENCE_WORKSPACE = "${HostAlias}:${RemoteDir}"
        }
        disabled = $false
        timeout = @{ startup = 30000; execution = 120000 }
      }
    }
  }
}
$config | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $ProjectDir 'opencode.json') -Encoding utf8
Push-Location $ProjectDir

try {
  Write-Host "== opencode version / mcp list ==" -ForegroundColor Cyan
  opencode --version
  # opencode v2.1.4 observed quirk: `mcp list` reports "No MCP servers configured" even when the
  # project config is loaded (verified via `opencode debug config` and real tool calls), so this is
  # informational only and does not fail the run.
  opencode mcp list

  $modelArg = @()
  if ($Model) { $modelArg = @('--model', $Model) }

  $cases = @(
    @{
      Name = '列出远程机器'
      Prompt = "只使用 presence 工具回答：列出我能连接的远程机器别名，不要用别的办法。"
      Expect = 'server'
    },
    @{
      Name = '远程执行命令'
      Prompt = "用 presence 在 $HostAlias 上执行 uname -a，并告诉我内核版本和机器架构。"
      Expect = 'Linux'
    },
    @{
      Name = '读取远端文件'
      Prompt = "用 presence 读取 $RemoteDir/VAE/sample.py 的前 10 行并原样贴出来。"
      Expect = 'coding: utf-8'
    }
    @{
      Name = '错误恢复（hint）'
      Prompt = "用 presence 读取 $RemoteDir/VAE/does-not-exist.py，如果报错就根据提示告诉我怎么改，最多重试一次。"
      Expect = 'does-not-exist'
    }
  )

  $results = @()
  foreach ($case in $cases) {
    Write-Host "`n== $($case.Name) ==" -ForegroundColor Cyan
    $started = Get-Date
    $prompt = $case.Prompt
    $ErrorActionPreference = 'Continue'
    $output = & opencode run --auto @modelArg $prompt 2>&1 | Out-String
    $ErrorActionPreference = 'Stop'
    $elapsed = [int]((Get-Date) - $started).TotalSeconds
    Write-Host $output
    if ($output -match 'usage limit|subscribe to OpenCode Go|Insufficient account funds|not available in your country') {
      $results += [pscustomobject]@{ case = $case.Name; ok = $null; seconds = $elapsed; note = 'model quota/geo' }
      Write-Host ("=> SKIP  ({0}s) — the selected model is out of quota / geo-blocked; pick another -Model" -f $elapsed) -ForegroundColor Yellow
      continue
    }
    $ok = $output -match [regex]::Escape($case.Expect) -and $output -notmatch 'EPERM|presence_mcp.*failed'
    $results += [pscustomobject]@{ case = $case.Name; ok = $ok; seconds = $elapsed; note = '' }
    Write-Host ("=> {0}  ({1}s)" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $elapsed) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  }

  Write-Host "`n== summary ==" -ForegroundColor Cyan
  $results | Format-Table -AutoSize
  $failed = @($results | Where-Object { $_.ok -eq $false }).Count
  $skipped = @($results | Where-Object { $null -eq $_.ok }).Count
  Write-Host ("{0} passed, {1} skipped, {2} failed" -f ($results.Count - $failed - $skipped), $skipped, $failed)
  exit $(if ($failed -eq 0) { 0 } else { 1 })
} finally {
  Pop-Location
}
