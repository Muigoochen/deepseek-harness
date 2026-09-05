# uninstall.ps1 — remove the lsp-echo plugin from the DSH user profile.
param(
  [string]$ProfileRoot = ''
)

if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}

function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
$patchFile = Join-Path $ProfileRoot 'profiles\web\cordis.patch.yml'
$dest = Join-Path $ProfileRoot 'profiles\node_modules\@dsh-user\lsp-echo'

# 1. remove the installed package
if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
  Write-Host "removed: $dest"
} else {
  Write-Host "nothing installed at: $dest"
}

# 2. drop every patch operation block that inserts id lsp-echo
if (Test-Path $patchFile) {
  $lines = Get-Content $patchFile
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
  Write-Host "updated: $patchFile"
}

Write-Host 'done. Restart `dsh web` for the removal to take effect.'
