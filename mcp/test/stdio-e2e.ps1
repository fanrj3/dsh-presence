# Real stdio MCP session against `mcp/server.mjs`.
#
# Works in a normal PowerShell *and* inside the DSH sandbox: PowerShell's .NET
# process pipes are allowed, unlike Node child_process pipes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File mcp/test/stdio-e2e.ps1
#   powershell ... -File mcp/test/stdio-e2e.ps1 -HostAlias server

param(
  [string]$HostAlias = 'server',
  [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$server = Join-Path $repo 'mcp\server.mjs'
if (-not (Test-Path $server)) { throw "server not found: $server" }

$env:PRESENCE_HOST = $HostAlias

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Command node).Source
$psi.Arguments = "`"$server`""
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

function Send([hashtable]$message) {
  $proc.StandardInput.WriteLine(($message | ConvertTo-Json -Compress -Depth 12))
  $proc.StandardInput.Flush()
}

function Receive-Response([string]$id) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    $task = $proc.StandardOutput.ReadLineAsync()
    if (-not $task.Wait([Math]::Max(1, [int]($deadline - (Get-Date)).TotalMilliseconds))) { break }
    $line = $task.Result
    if (-not $line) { break }
    try { $message = $line | ConvertFrom-Json } catch { continue }
    if ($null -ne $message.id -and "$($message.id)" -eq "$id") { return $message }
  }
  throw "timed out waiting for response id=$id"
}

$results = @()
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  $script:results += [pscustomobject]@{ ok = $ok; name = $name; detail = $detail }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("{0}  {1}{2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $(if ($detail) { " — $detail" } else { '' })) -ForegroundColor $color
}

try {
  Send @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'presence-stdio-e2e'; version = '0.0.0' } } }
  $init = Receive-Response '1'
  Check 'initialize' ($init.result.serverInfo.name -eq 'presence') ("{0}@{1}, protocol {2}" -f $init.result.serverInfo.name, $init.result.serverInfo.version, $init.result.protocolVersion)
  Send @{ jsonrpc = '2.0'; method = 'notifications/initialized' }

  Send @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }
  $tools = Receive-Response '2'
  $names = @($tools.result.tools | ForEach-Object { $_.name })
  Check 'tools/list' ($names.Count -ge 15 -and $names -contains 'presence_exec') ("{0} tools" -f $names.Count)

  Send @{ jsonrpc = '2.0'; id = 3; method = 'tools/call'; params = @{ name = 'presence_exec'; arguments = @{ host = $HostAlias; command = 'uname -s && hostname'; cwd = '/tmp' } } }
  $exec = Receive-Response '3'
  $execText = ($exec.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  Check 'presence_exec over stdio' ($exec.result.isError -ne $true -and $execText -match 'Linux') $execText.Replace("`n", ' | ')

  Send @{ jsonrpc = '2.0'; id = 4; method = 'tools/call'; params = @{ name = 'presence_status'; arguments = @{} } }
  $status = Receive-Response '4'
  $statusText = ($status.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  $parsed = $null
  try { $parsed = $statusText | ConvertFrom-Json } catch { $parsed = $null }
  Check 'presence_status over stdio' ($parsed.server -eq 'presence-mcp' -and $parsed.tools -ge 15) ("hosts={0} readOnly={1}" -f $parsed.hosts.Count, $parsed.readOnly)

  Send @{ jsonrpc = '2.0'; id = 5; method = 'tools/call'; params = @{ name = 'presence_connect'; arguments = @{ host = 'definitely-not-a-host' } } }
  $bad = Receive-Response '5'
  $badText = ($bad.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  Check '错误体验（带 hint）' ($bad.result.isError -eq $true -and $badText -match 'hint:') $badText.Split("`n")[0]
} catch {
  Check 'stdio session' $false ($_.Exception.Message)
} finally {
  try { $proc.StandardInput.Close() } catch { }
  Start-Sleep -Milliseconds 300
  if (-not $proc.HasExited) { $proc.Kill() }
  $stderr = $proc.StandardError.ReadToEnd()
  $firstError = ($stderr.Trim() -split "`n")[0]
  if ($firstError) { Write-Host "server stderr: $firstError" -ForegroundColor DarkGray }
}

$failed = @($results | Where-Object { -not $_.ok }).Count
Write-Host ("`n{0}/{1} passed" -f ($results.Count - $failed), $results.Count)
exit $(if ($failed -eq 0) { 0 } else { 1 })
