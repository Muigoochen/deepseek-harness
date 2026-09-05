# install.ps1 — install the lsp-echo plugin into the DSH user profile.
# Idempotent: copies the package, generates a machine-local bridge config when
# missing, and appends the cordis.patch.yml row exactly once.
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -GodotBin "E:\Godot Engine\...\Godot_v4.7..._console.exe" -Project "E:\GodotProject\xu_world"
param(
  [string]$PluginSource = (Join-Path $PSScriptRoot '..'),            # plugins/lsp-echo
  [string]$ProfileRoot   = '',                                       # defaults to $env:DSH_HOME or ~\.dsh
  [string]$GodotBin      = '',
  [string]$Project       = ''
)

$ErrorActionPreference = 'Stop'

# Write UTF-8 without BOM (PowerShell 5.1's Set-Content -Encoding UTF8 adds a BOM
# that breaks JSON.parse/YAML consumers).
function Write-TextNoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- locate profile ----------
if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}
$patchFile = Join-Path $ProfileRoot 'profiles\web\cordis.patch.yml'
if (-not (Test-Path $patchFile)) { throw "profile patch not found: $patchFile (expected DSH_HOME layout profiles\web\cordis.patch.yml)" }
$dest = Join-Path $ProfileRoot 'profiles\node_modules\@dsh-user\lsp-echo'
$engineDir = Join-Path $dest 'checkers\godot-lsp'

Write-Host "source : $PluginSource"
Write-Host "target : $dest"

# ---------- 1. copy the package (skip machine/runtime artifacts) ----------
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
Copy-Item (Join-Path $PluginSource 'package.json') (Join-Path $dest 'package.json') -Force
Copy-Item (Join-Path $PluginSource 'README.md') (Join-Path $dest 'README.md') -Force
Copy-Item (Join-Path $PluginSource 'lib\*.js') (Join-Path $dest 'lib\') -Force
Copy-Item (Join-Path $PluginSource 'checkers\godot-lsp\engine.json') (Join-Path $engineDir 'engine.json') -Force
Copy-Item (Join-Path $PluginSource 'checkers\godot-lsp\godot-lsp.mjs') (Join-Path $engineDir 'godot-lsp.mjs') -Force
Copy-Item (Join-Path $PluginSource 'checkers\godot-lsp\godot-lsp.config.example.json') (Join-Path $engineDir 'godot-lsp.config.example.json') -Force
Copy-Item (Join-Path $PluginSource 'checkers\godot-lsp\README.md') (Join-Path $engineDir 'README.md') -Force
if (Test-Path (Join-Path $PluginSource 'checkers\godot-lsp\reference')) {
  Copy-Item (Join-Path $PluginSource 'checkers\godot-lsp\reference') (Join-Path $engineDir 'reference') -Recurse -Force
}

# ---------- 2. machine-local bridge config (only when missing) ----------
$machineConfig = Join-Path $engineDir 'godot-lsp.config.json'
if (-not (Test-Path $machineConfig)) {
  if (-not $GodotBin) {
    try { $GodotBin = (Get-Command godot -ErrorAction Stop).Source } catch { $GodotBin = '' }
  }
  if (-not $Project) {
    $localDev = Join-Path (Join-Path $PluginSource 'checkers\godot-lsp') 'godot-lsp.config.local-dev.json'
    if (Test-Path $localDev) {
      try { $Project = (Get-Content $localDev | ConvertFrom-Json).defaultProject } catch { $Project = '' }
    }
  }
  $cfg = @{
    godotBin       = $GodotBin
    defaultProject = $Project
    watchSkip      = @('.godot', 'addons')
    out            = ''
  } | ConvertTo-Json
  Write-TextNoBom -Path $machineConfig -Text $cfg
  Write-Host "wrote machine config: $machineConfig"
} else {
  Write-Host "kept existing machine config: $machineConfig"
}

# ---------- 3. cordis.patch.yml row (append exactly once) ----------
$needle = 'name: ''@dsh-user/lsp-echo'''
$content = Get-Content $patchFile -Raw
if ($content -match [regex]::Escape($needle)) {
  Write-Host "patch row already present: $patchFile"
} else {
  $row = @"
- insert:
    - id: lsp-echo
      name: '@dsh-user/lsp-echo'
      config:
        projects:
          - path: '${Project}'
"@
  $content = $content.TrimEnd() + "`r`n" + $row + "`r`n"
  Write-TextNoBom -Path $patchFile -Text $content
  Write-Host "appended lsp-echo row to: $patchFile"
}

Write-Host ''
Write-Host 'installed. Restart `dsh web` to activate (a running instance keeps its host rows).'
Write-Host "verify later with: node `"$dest`/checkers/godot-lsp/godot-lsp.mjs`" smoke <projectFile>"
