# scripts/reference_mdx.ps1 — one output folder per model id, so every consumer (parity, E2E, Tier 2 gate) picks stems by modelId.
# Every path is ABSOLUTE and built from the single task root, so the script runs identically from any cwd.
param([string[]]$Models = @('UVR-MDX-NET-Voc_FT.onnx', 'UVR_MDXNET_9482.onnx'))      # BOTH always: 9482 is the iOS model (§7.5), so its reference stems are required, not conditional
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Task    = 'c:\Users\wuminqia\Documents\Amazon\Kiro\20261102_vocal_splitter'
$Repo    = Join-Path $Task 'repo'
$Fixture = Join-Path $Repo 'tests\fixtures\clip25.wav'
$ModelsSrc = Join-Path $Repo 'models_src'
$AudioSep  = Join-Path $Task 'venv\Scripts\audio-separator.exe'
$Log     = Join-Path $Task 'evidence\ref\reference_mdx.log'
$FolderByModel = @{ 'UVR-MDX-NET-Voc_FT.onnx' = 'uvr_mdx_voc_ft'; 'UVR_MDXNET_9482.onnx' = 'uvr_mdxnet_9482' }
$Manifest = Get-Content (Join-Path $Repo 'site\models\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($m in $Models) {
  $Id   = $FolderByModel[$m]
  $DimT = [int]$Manifest.models.$Id.params.dimT          # the chunker wrote segmentSize = dimT (§3.1); 256 for Voc_FT
  $Out  = Join-Path $Task ("evidence\ref\" + $Id)
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  $Extra = @()
  if ($DimT -ne 256) { $Extra = @('--mdx_segment_size', "$DimT") }   # keeps audio-separator on its ORT path (segment_size == dim_t, mdx_separator.py:115)
  "$m dimT=$DimT extra=$($Extra -join ' ')" | Out-File -Append -Encoding utf8 $Log
  & $AudioSep $Fixture --model_filename $m --model_file_dir $ModelsSrc --output_dir $Out --output_format WAV --use_soundfile @Extra 2>&1 |
    Out-File -Append -Encoding utf8 $Log
  if ($LASTEXITCODE -ne 0) { "FAILED $m exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 $Log; exit $LASTEXITCODE }
}
