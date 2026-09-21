# uninstall.ps1 - remove toast from a DSH profile.
#
# Removal goes through `dsh plugin remove`, which drops the dependency from the
# profile and reconciles its bundle list. Do NOT delete the profile's
# node_modules entry by hand: while the plugin is installed that path is a
# junction back to the checkout, and a recursive delete through a junction can
# take the checkout's files with it.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so
# non-ASCII text in this file would be mangled into a parse error.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
param(
  [string]$ProfileRoot = '',   # defaults to $env:DSH_HOME or ~\.dsh
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'

function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}
$patchFile = Join-Path $ProfileRoot "profiles\$ProfileName\cordis.patch.yml"
$dest = Join-Path $ProfileRoot "profiles\$ProfileName\node_modules\@dsh-user\toast"

# ---------- 1. unlink the package from the profile ----------
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if (-not $pnpm) { throw 'pnpm is not on PATH; `dsh plugin` needs it to unlink the package' }
$pnpmExe = $pnpm.Source
if ($pnpmExe -like '*.ps1') {
  # Invoking the .ps1 shim fails under the default execution policy on Windows.
  $cmd = [System.IO.Path]::ChangeExtension($pnpmExe, '.cmd')
  if (Test-Path $cmd) { $pnpmExe = $cmd }
}
# `dsh plugin` forwards to pnpm inside the profile, so any directory works here.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$removeOut = (& $pnpmExe dsh plugin --profile $ProfileName remove '@dsh-user/toast' 2>&1 | Out-String)
$removeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($removeExit -ne 0) {
  Write-Host 'dsh plugin remove reported a problem (continuing with the patch row):' -ForegroundColor Yellow
  Write-Host $removeOut
}
if (Test-Path $dest) {
  Write-Host "still present after remove: $dest (remove it by hand only if it is not a link)"
} else {
  Write-Host 'package removed from the profile'
}

# ---------- 2. drop every patch operation that targets id toast ----------
# Two shapes are patch operations at the TOP level: an `- insert:` list (how a bundle
# contributes a row) and a lone `- id: <name>` entry (how a profile layer overrides a
# row an earlier layer inserted). Both must be removed, or the profile keeps a row
# pointing at a package that is no longer installed.
# ReadAllLines, not Get-Content: PowerShell 5.1's default ANSI decoding would
# re-encode any non-ASCII path in this file when it is written back.
if (Test-Path $patchFile) {
  $lines = [System.IO.File]::ReadAllLines($patchFile)
  $idNeedle = "(?m)^\s*- id: toast\s*$"
  $nameNeedle = "name: '@dsh-user/toast'"
  $ops = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -ceq '- insert:' -or $lines[$i] -cmatch '^- id: ') {
      $end = $i + 1
      # A block runs until the next top-level operation or the next top-level line.
      # Row lines are indented, so an unindented line ends the block; stopping only at
      # the next `- insert:` would let the LAST block swallow whatever follows it.
      while ($end -lt $lines.Count) {
        $candidate = $lines[$end]
        if ($candidate.Trim() -ceq '- insert:' -or $candidate -cmatch '^- id: ') { break }
        if ($candidate.Trim() -ne '' -and $candidate -notmatch '^\s') { break }
        $end++
      }
      $ops.Add(@{ Start = $i; End = $end })
      $i = $end - 1
    }
  }
  $kept = New-Object System.Collections.Generic.List[string]
  $removed = $false
  $cursor = 0
  foreach ($op in $ops) {
    # Keep whatever sits between the previous operation and this one (file header comments).
    for ($j = $cursor; $j -lt $op.Start; $j++) { $kept.Add($lines[$j]) }
    $cursor = $op.End
    $block = ($lines[$op.Start..($op.End - 1)] -join "`n")
    if ($block -cmatch $idNeedle -or $block -cmatch ([regex]::Escape($nameNeedle))) { $removed = $true; continue }
    for ($j = $op.Start; $j -lt $op.End; $j++) { $kept.Add($lines[$j]) }
  }
  for ($j = $cursor; $j -lt $lines.Count; $j++) { $kept.Add($lines[$j]) }
  # Only write when a row was actually found: rewriting unconditionally would empty
  # a patch file that carries no `- insert:` operations at all.
  if ($removed) {
    $outText = ($kept -join "`r`n")
    # An all-comment or empty result is not a valid patch file: the loader requires a
    # top-level YAML array and throws on anything else, so write the empty array form.
    $meaningful = @($kept | Where-Object {
      $line = $_.Trim()
      $line -ne '' -and $line -notmatch '^#' -and $line -notin @('---', '...', 'null', '~')
    })
    if ($meaningful.Count -eq 0) { $outText = '[]' }
    Write-TextNoBom -Path $patchFile -Text ($outText + "`r`n")
    Write-Host "removed the toast row from: $patchFile"
  } else {
    Write-Host "no toast row found in: $patchFile"
  }
} else {
  Write-Host "patch file not found: $patchFile"
}

Write-Host ''
Write-Host 'done. Restart `dsh web` for the removal to take effect.'
