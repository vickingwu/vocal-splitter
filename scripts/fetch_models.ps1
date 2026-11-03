# scripts/fetch_models.ps1 — download the model files into models_src/ (gitignored) and verify their
# whole-file SHA-256 against scripts/data/expected_sha256.json (design §6.1). FAILS on mismatch.
# Tier 1 (always): UVR-MDX-NET-Voc_FT.onnx and UVR_MDXNET_9482.onnx from the TRvlvr release.
# Tier 2 (-Tier2 switch, off by default): the Mel-Band RoFormer duality student .onnx + .onnx.data (HF, then hf-mirror).
# Writes ../evidence/models_sha256.json (or $env:VS_EVIDENCE_DIR\models_sha256.json).
param([switch]$Tier2)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Dst = Join-Path $Repo 'models_src'
$EvidenceDir = if ($env:VS_EVIDENCE_DIR) { $env:VS_EVIDENCE_DIR } else { Join-Path (Split-Path -Parent $Repo) 'evidence' }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$Expected = Get-Content (Join-Path $Repo 'scripts\data\expected_sha256.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$Files = @(
  @{ name = 'UVR-MDX-NET-Voc_FT.onnx'; urls = @('https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx') },
  @{ name = 'UVR_MDXNET_9482.onnx';    urls = @('https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_9482.onnx') }
)
if ($Tier2) {
  foreach ($f in @('duality_student_core_t1100.onnx', 'duality_student_core_t1100.onnx.data')) {
    $Files += @{ name = $f; urls = @(
      "https://huggingface.co/musetric/mel-band-roformer-duality-student-onnx/resolve/main/$f",
      "https://hf-mirror.com/musetric/mel-band-roformer-duality-student-onnx/resolve/main/$f") }
  }
}

$results = @()
$fail = $false
foreach ($f in $Files) {
  $name = $f.name
  $path = Join-Path $Dst $name
  $want = $Expected.$name
  if (-not $want) { Write-Host "FAIL no expected sha256 for $name"; $fail = $true; continue }
  $have = $null
  if (Test-Path $path) { $have = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower() }
  if ($have -ne $want) {
    foreach ($u in $f.urls) {
      Write-Host "downloading $name from $u"
      & curl.exe -L --retry 3 --retry-delay 5 -o $path $u
      if ($LASTEXITCODE -eq 0 -and (Test-Path $path)) {
        $have = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower()
        if ($have -eq $want) { break }
        Write-Host "sha256 mismatch after download from $u ($have)"
      } else { Write-Host "curl exit $LASTEXITCODE for $u" }
    }
  }
  $bytes = if (Test-Path $path) { (Get-Item $path).Length } else { 0 }
  $match = ($have -eq $want)
  if (-not $match) { $fail = $true }
  Write-Host ("{0} {1}  bytes={2}  sha256={3}" -f ($(if ($match) { 'ok  ' } else { 'FAIL' })), $name, $bytes, $have)
  $results += [ordered]@{ name = $name; bytes = $bytes; sha256 = $have; expected = $want; match = $match; path = $path; sources = $f.urls }
}

$doc = [ordered]@{ date = (Get-Date -Format o); tier2 = [bool]$Tier2; files = $results }
$doc | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 (Join-Path $EvidenceDir 'models_sha256.json')
if ($fail) { Write-Host 'fetch_models: FAILED (sha256 mismatch or download error)'; exit 1 }
Write-Host 'fetch_models: all files verified'
exit 0
