# tests/lib/proc_mem.ps1 — renderer memory of the Playwright-launched Chromium (Windows), one JSON line per sample on stdout:
#   { "browserPid": n, "renderers": [ { "pid": n, "ws": bytes, "priv": bytes } ] }
# browser = the chrome.exe/headless_shell.exe under ms-playwright with --remote-debugging-pipe and NO --type= switch (children
# inherit the pipe flag), created after -SinceMs (Unix ms); renderers = its --type=renderer children (page + dedicated workers
# = the ORT WASM heap). -Loop samples every -IntervalMs with cheap Get-Process calls and re-discovers the tree (Win32_Process,
# the expensive call) every -RediscoverMs, so the sampler does not perturb the chunk timings it runs next to. The caller kills
# the process when done; -MaxSeconds is the safety stop. Used by startProcessMemoryPoller (tests/lib/e2e-helpers.mjs).
param([double]$SinceMs = 0, [switch]$Loop, [int]$IntervalMs = 500, [int]$RediscoverMs = 10000, [int]$MaxSeconds = 1800)
$ErrorActionPreference = 'SilentlyContinue'
$since = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc).AddMilliseconds($SinceMs).ToLocalTime()

function Discover {
  $rows = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='headless_shell.exe' OR Name='msedge.exe'")
  $browser = $rows | Where-Object { $_.CommandLine -and $_.CommandLine -match 'ms-playwright' -and $_.CommandLine -match 'remote-debugging-pipe' -and $_.CommandLine -notmatch '--type=' -and $_.CreationDate -ge $since } | Sort-Object CreationDate | Select-Object -Last 1
  if (-not $browser) { return $null }
  $pids = @($rows | Where-Object { $_.ParentProcessId -eq $browser.ProcessId -and $_.CommandLine -and $_.CommandLine -match '--type=renderer' } | ForEach-Object { [int]$_.ProcessId })
  return @{ browserPid = [int]$browser.ProcessId; pids = $pids }
}

function Sample($tree) {
  if (-not $tree) { return '{"browserPid":null,"renderers":[]}' }
  $list = New-Object System.Collections.ArrayList
  foreach ($id in $tree.pids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { [void]$list.Add(('{{"pid":{0},"ws":{1},"priv":{2}}}' -f $p.Id, [int64]$p.WorkingSet64, [int64]$p.PrivateMemorySize64)) }
  }
  return ('{{"browserPid":{0},"renderers":[{1}]}}' -f $tree.browserPid, ($list -join ','))
}

$tree = Discover
if (-not $Loop) { Write-Output (Sample $tree); exit 0 }
$start = Get-Date
$lastDiscover = Get-Date
while (((Get-Date) - $start).TotalSeconds -lt $MaxSeconds) {
  if (-not $tree -or ((Get-Date) - $lastDiscover).TotalMilliseconds -ge $RediscoverMs) { $tree = Discover; $lastDiscover = Get-Date }
  Write-Output (Sample $tree)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $IntervalMs
}
