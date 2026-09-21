# uninstall.ps1 — remove lsp-echo from a DSH profile.
#
# Removal goes through `dsh plugin remove`, which drops the dependency from the
# profile and reconciles its bundle list. Do NOT delete the profile's
# node_modules entry by hand: while the plugin is installed that path is a
# junction back to the checkout, and a recursive delete through a junction can
# take the checkout's files with it.
param(
  [string]$ProfileRoot = '',
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}

function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
$patchFile = Join-Path $ProfileRoot "profiles\$ProfileName\cordis.patch.yml"
$dest = Join-Path $ProfileRoot "profiles\node_modules\@dsh-user\lsp-echo"

# ---------- 1. unlink the package from the profile ----------
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if (-not $pnpm) { throw 'pnpm is not on PATH; `dsh plugin` needs it to unlink the package' }
$pnpmExe = $pnpm.Source
if ($pnpmExe -like '*.ps1') {
  # Invoking the .ps1 shim fails under the default execution policy on Windows.
  $cmd = [System.IO.Path]::ChangeExtension($pnpmExe, '.cmd')
  if (Test-Path $cmd) { $pnpmExe = $cmd }
}
# `dsh plugin` forwards to pnpm inside the profile, so any directory works here;
# the checkout is only needed for a relative spec, and this one is absolute.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$removeOut = (& $pnpmExe dsh plugin --profile $ProfileName remove '@dsh-user/lsp-echo' 2>&1 | Out-String)
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

# ---------- 2. drop every patch operation block that inserts id lsp-echo ----------
# ReadAllText, not Get-Content: PowerShell 5.1's default ANSI decoding would
# re-encode any non-ASCII path in this file when it is written back.
if (Test-Path $patchFile) {
  $lines = [System.IO.File]::ReadAllLines($patchFile)
  $ops = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '- insert:') {
      $end = $i + 1
      while ($end -lt $lines.Count -and $lines[$end].Trim() -ne '- insert:') { $end++ }
      $ops.Add(@{ Start = $i; End = $end })
      $i = $end - 1
    }
  }
  $keep = New-Object System.Collections.Generic.List[string]
  foreach ($op in $ops) {
    $body = ($lines[$op.Start..($op.End - 1)] -join "`n")
    if ($body -match [regex]::Escape('- id: lsp-echo')) { continue }
    for ($j = $op.Start; $j -lt $op.End; $j++) { $keep.Add($lines[$j]) }
  }
  Write-TextNoBom -Path $patchFile -Text ($keep -join "`r`n")
  Write-Host "removed the lsp-echo row from: $patchFile"
}

# The machine config and runtime state under $DSH_HOME are left in place: they
# hold this machine's engine paths, and reinstalling should not require retyping
# them. Delete $DSH_HOME\lsp-echo and $DSH_HOME\lsp-echo-runtime by hand to clear
# them.
Write-Host 'done. Restart `dsh web` for the removal to take effect.'
