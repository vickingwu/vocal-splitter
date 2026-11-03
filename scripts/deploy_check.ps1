# scripts/deploy_check.ps1 — test E (design §16.E / §17.2a): poll ONE pages.yml run to success with headSha == HEAD,
# then curl the live site.
#   -RunId <id>                 the run to poll (preferred); otherwise
#   -Event push|workflow_dispatch  the latest run of that event
#   -MimeOnly                   only the M0 MIME check (app.mjs / ort.wasm.min.mjs / .wasm / manifest.json) -> ../evidence/mime_check.json
#   (full mode)                 / -> 200, manifest + every chunk 200 with Content-Length == manifest bytes, MIME types,
#                               cache-control -> ../evidence/live_check.json  (the live E2E runs are launched separately)
#   -Repo owner/name, -LiveUrl  override what ../evidence/m0_deploy.json says
# Needs `gh` with GH_TOKEN (taken from Git Credential Manager when absent; only its length is logged). Exit 0 = all checks passed.
param(
  [string]$RunId = '',
  [ValidateSet('', 'push', 'workflow_dispatch')][string]$Event = '',
  [switch]$MimeOnly,
  [string]$Repo = '',
  [string]$LiveUrl = '',
  [int]$MaxMinutes = 15
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$RepoDir = Split-Path -Parent $PSScriptRoot
$EvidenceDir = if ($env:VS_EVIDENCE_DIR) { $env:VS_EVIDENCE_DIR } else { Join-Path (Split-Path -Parent $RepoDir) 'evidence' }
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$Tmp = Join-Path $EvidenceDir '_deploy_check_tmp'
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Log($s) { Write-Host ("[deploy_check] " + $s) }

# --- repo / live URL -------------------------------------------------------------------------------------------
$deployInfo = $null
$infoPath = Join-Path $EvidenceDir 'm0_deploy.json'
if (Test-Path $infoPath) { $deployInfo = (Get-Content $infoPath -Raw -Encoding UTF8) -replace '^\xEF\xBB\xBF', '' | ConvertFrom-Json }
if (-not $Repo) { if ($deployInfo) { $Repo = "$($deployInfo.owner)/$($deployInfo.repo)" } else { $Repo = 'vickingwu/vocal-splitter' } }
if (-not $LiveUrl) { if ($deployInfo -and $deployInfo.liveUrl) { $LiveUrl = $deployInfo.liveUrl } else { $LiveUrl = "https://$($Repo.Split('/')[0]).github.io/$($Repo.Split('/')[1])/" } }
if (-not $LiveUrl.EndsWith('/')) { $LiveUrl += '/' }
Log "repo=$Repo liveUrl=$LiveUrl"

# --- token ---------------------------------------------------------------------------------------------------
if (-not $env:GH_TOKEN) {
  $cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  $pw = ($cred | Where-Object { $_ -like 'password=*' } | Select-Object -First 1)
  if ($pw) { $env:GH_TOKEN = $pw.Substring('password='.Length) }
}
Log ("GH_TOKEN length=" + $(if ($env:GH_TOKEN) { $env:GH_TOKEN.Length } else { 0 }))

# --- resolve the run id --------------------------------------------------------------------------------------
Push-Location $RepoDir
$head = (& git rev-parse HEAD).Trim()
Pop-Location
Log "HEAD=$head"

if (-not $RunId) {
  if (-not $Event) { Log 'need -RunId or -Event'; exit 2 }
  $listFile = Join-Path $Tmp 'run_list.json'
  $found = $null
  for ($i = 0; $i -lt 12 -and -not $found; $i++) {
    & gh run list -R $Repo --workflow pages.yml --event $Event --limit 5 --json databaseId,status,conclusion,headSha,createdAt 2>$null | Out-File -Encoding ascii $listFile
    $runs = @()
    # PowerShell 5.1: ConvertFrom-Json hands a JSON array over as ONE pipeline object; enumerate it so each run is an element
    try { $runs = @(((Get-Content $listFile -Raw) | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $runs = @() }
    $found = $runs | Where-Object { $_.headSha -eq $head } | Select-Object -First 1
    if (-not $found) { Start-Sleep -Seconds 10 }
  }
  if (-not $found) { Log "no $Event run for HEAD $head found"; exit 1 }
  $RunId = "$($found.databaseId)"
}
Log "polling run $RunId"

# --- poll ------------------------------------------------------------------------------------------------------
$viewFile = Join-Path $Tmp 'run_view.json'
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$run = $null
while ($true) {
  & gh run view $RunId -R $Repo --json status,conclusion,headSha,event,url,createdAt,updatedAt 2>$null | Out-File -Encoding ascii $viewFile
  try { $run = (Get-Content $viewFile -Raw) | ConvertFrom-Json } catch { $run = $null }
  if ($run) { Log ("run {0}: status={1} conclusion={2} headSha={3}" -f $RunId, $run.status, $run.conclusion, $run.headSha) }
  if ($run -and $run.status -eq 'completed') { break }
  if ((Get-Date) -gt $deadline) { Log 'timeout waiting for the run'; break }
  Start-Sleep -Seconds 20
}
$runOk = ($run -and $run.status -eq 'completed' -and $run.conclusion -eq 'success' -and $run.headSha -eq $head)
Log "runOk=$runOk (conclusion=$($run.conclusion), headSha match=$($run.headSha -eq $head))"

# --- HTTP helpers --------------------------------------------------------------------------------------------
function Head-Url([string]$u) {
  $raw = & curl.exe -sI -L --max-time 60 $u 2>$null
  $lines = @($raw)
  # take the LAST response block (after redirects)
  $blocks = @(); $cur = @()
  foreach ($l in $lines) { if ($l -match '^HTTP/') { if ($cur.Count) { $blocks += ,$cur }; $cur = @($l) } elseif ($l.Trim() -ne '') { $cur += $l } }
  if ($cur.Count) { $blocks += ,$cur }
  $last = if ($blocks.Count) { $blocks[$blocks.Count - 1] } else { @() }
  $status = 0; $ct = ''; $cl = -1; $cc = ''
  foreach ($l in $last) {
    if ($l -match '^HTTP/\S+\s+(\d{3})') { $status = [int]$Matches[1] }
    elseif ($l -match '^(?i)content-type:\s*(.+)$') { $ct = $Matches[1].Trim() }
    elseif ($l -match '^(?i)content-length:\s*(\d+)') { $cl = [int64]$Matches[1] }
    elseif ($l -match '^(?i)cache-control:\s*(.+)$') { $cc = $Matches[1].Trim() }
  }
  return [ordered]@{ url = $u; status = $status; contentType = $ct; contentLength = $cl; cacheControl = $cc }
}
function Is-Js([string]$ct) { return ($ct -match '^(text/javascript|application/javascript|application/x-javascript)(\s*;.*)?$') }

$allOk = $runOk
if ($MimeOnly) {
  $targets = @('app.mjs', 'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm', 'models/manifest.json')
  $results = @()
  foreach ($t in $targets) { $r = Head-Url ($LiveUrl + $t); $results += $r; Log ("{0} -> {1} {2} len={3}" -f $t, $r.status, $r.contentType, $r.contentLength) }
  $root = Head-Url $LiveUrl
  Log ("/ -> {0} {1}" -f $root.status, $root.contentType)
  $mjsOk = ($results[0].status -eq 200) -and (Is-Js $results[0].contentType) -and ($results[1].status -eq 200) -and (Is-Js $results[1].contentType)
  $wasmOk = ($results[2].status -eq 200) -and ($results[2].contentType -match '^application/wasm')
  $manifestOk = ($results[3].status -eq 200)
  $allOk = $allOk -and $mjsOk -and $wasmOk -and $manifestOk -and ($root.status -eq 200)
  $doc = [ordered]@{
    date = (Get-Date -Format o); repo = $Repo; liveUrl = $LiveUrl; runId = $RunId; headSha = $head
    run = $run; runOk = $runOk; root = $root; files = $results
    mjsIsJavaScript = $mjsOk; wasmIsApplicationWasm = $wasmOk; manifestOk = $manifestOk; renamed = $false; ok = $allOk
  }
  $doc | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $EvidenceDir 'mime_check.json')
  Log "mime_check.json written ok=$allOk"
} else {
  $root = Head-Url $LiveUrl
  Log ("/ -> {0}" -f $root.status)
  $allOk = $allOk -and ($root.status -eq 200)
  $manifestPath = Join-Path $RepoDir 'site\models\manifest.json'
  $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $mf = Head-Url ($LiveUrl + 'models/manifest.json')
  $localManifestBytes = (Get-Item $manifestPath).Length
  Log ("manifest -> {0} len={1} (local {2}) cache-control='{3}'" -f $mf.status, $mf.contentLength, $localManifestBytes, $mf.cacheControl)
  $allOk = $allOk -and ($mf.status -eq 200)
  $chunks = @()
  foreach ($mid in $manifest.models.PSObject.Properties.Name) {
    $model = $manifest.models.$mid
    foreach ($fk in $model.files.PSObject.Properties.Name) {
      foreach ($c in $model.files.$fk.chunks) {
        $r = Head-Url ($LiveUrl + $c.path)
        $ok = ($r.status -eq 200) -and ($r.contentLength -eq [int64]$c.bytes)
        $chunks += [ordered]@{ path = $c.path; expectedBytes = $c.bytes; status = $r.status; contentLength = $r.contentLength; contentType = $r.contentType; ok = $ok }
        Log ("{0} -> {1} len={2}/{3} {4}" -f $c.path, $r.status, $r.contentLength, $c.bytes, $(if ($ok) { 'ok' } else { 'FAIL' }))
        $allOk = $allOk -and $ok
      }
    }
  }
  $app = Head-Url ($LiveUrl + 'app.mjs'); $wasm = Head-Url ($LiveUrl + 'vendor/ort/ort-wasm-simd-threaded.wasm')
  $mjsOk = ($app.status -eq 200) -and (Is-Js $app.contentType); $wasmOk = ($wasm.status -eq 200) -and ($wasm.contentType -match '^application/wasm')
  $allOk = $allOk -and $mjsOk -and $wasmOk
  $authUrl = $LiveUrl + 'auth.mjs'
  $authBody = & curl.exe -s -L --max-time 60 $authUrl 2>$null | Out-String
  $authHasHash = $authBody -match 'HASH_HEX'
  $authHasPw = $false
  if ($env:VS_TEST_PASS) { $authHasPw = $authBody.Contains($env:VS_TEST_PASS) }
  $allOk = $allOk -and $authHasHash -and (-not $authHasPw)
  # compared in memory only; the file carries the verdict, never the value
  ("date={0} url={1} hasHashHex={2} containsPassword={3} passwordChecked={4}" -f (Get-Date -Format o), $authUrl, $authHasHash, $authHasPw, [bool]$env:VS_TEST_PASS) | Out-File -Encoding utf8 (Join-Path $EvidenceDir 'live_auth_check.txt')
  $doc = [ordered]@{
    date = (Get-Date -Format o); repo = $Repo; liveUrl = $LiveUrl; runId = $RunId; headSha = $head; run = $run; runOk = $runOk
    root = $root; manifest = $mf; manifestVersion = $manifest.version; chunks = $chunks
    app = $app; wasm = $wasm; mjsIsJavaScript = $mjsOk; wasmIsApplicationWasm = $wasmOk
    authMjsHasHashHex = $authHasHash; authMjsContainsTestPassword = $authHasPw; testPasswordChecked = [bool]$env:VS_TEST_PASS
    ok = $allOk
  }
  $doc | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $EvidenceDir 'live_check.json')
  Log "live_check.json written ok=$allOk"
}
if ($allOk) { exit 0 } else { exit 1 }
