# install.ps1 - install repeat-stream-guard into the DSH user profile.
# Idempotent: copies the package and appends the cordis.patch.yml row exactly once.
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# so non-ASCII text in this file would be mangled into a parse error.
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File install.ps1
param(
  [string]$PluginSource = (Join-Path $PSScriptRoot '..'),   # plugins/repeat-stream-guard
  [string]$ProfileRoot   = ''                               # defaults to $env:DSH_HOME or ~\.dsh
)

$ErrorActionPreference = 'Stop'

# Write UTF-8 without BOM (PowerShell 5.1's Set-Content -Encoding UTF8 adds a BOM
# that breaks YAML/JSON consumers).
function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- sanity: artifacts must be present before install (fail-loud guard) ----------
if (-not (Test-Path (Join-Path $PluginSource 'lib\index.js'))) { throw "missing lib/index.js under $PluginSource" }

# ---------- locate profile ----------
if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}
$patchFile = Join-Path $ProfileRoot 'profiles\web\cordis.patch.yml'
if (-not (Test-Path $patchFile)) { throw "profile patch not found: $patchFile (expected DSH_HOME layout profiles\web\cordis.patch.yml)" }
$dest = Join-Path $ProfileRoot 'profiles\node_modules\@dsh-user\repeat-stream-guard'

Write-Host "source : $PluginSource"
Write-Host "target : $dest"

# ---------- 1. copy the package (lib + manifest + readme) ----------
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
Copy-Item (Join-Path $PluginSource 'package.json') (Join-Path $dest 'package.json') -Force
Copy-Item (Join-Path $PluginSource 'README.md') (Join-Path $dest 'README.md') -Force
Copy-Item (Join-Path $PluginSource 'lib\*.js') (Join-Path $dest 'lib\') -Force

# ---------- 2. cordis.patch.yml row (append exactly once) ----------
$needle = 'name: ''@dsh-user/repeat-stream-guard'''
$content = Get-Content $patchFile -Raw
if ($content -match [regex]::Escape($needle)) {
  Write-Host "patch row already present: $patchFile"
} else {
  $row = @"
- insert:
    - id: repeat-stream-guard
      name: '@dsh-user/repeat-stream-guard'
"@
  $content = $content.TrimEnd() + "`r`n" + $row + "`r`n"
  Write-TextNoBom -Path $patchFile -Text $content
  Write-Host "appended repeat-stream-guard row to: $patchFile"
}

Write-Host ''
Write-Host 'installed. Restart `dsh web` to activate (a running instance keeps its host rows).'
Write-Host 'verify: a repeating model output is cut short, and a warning toast appears top-right.'
