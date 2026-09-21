# install.ps1 - install repeat-stream-guard into a DSH profile the supported way.
#
# Installation is `dsh plugin --profile <name> add <package>`, which links the
# package into the profile and records it as a bundle, so the profile owns the
# dependency and the plugin's cordis.patch.yml supplies its row. This script does
# not copy files and does not delete the profile's package directory: while the
# plugin is installed that path is a junction back to this checkout, and a
# recursive delete through a junction can take the checkout's files with it.
#
# Idempotent: `add` on an already-linked package is a no-op.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so
# non-ASCII text in this file would be mangled into a parse error.
#
# Examples:
#   powershell -ExecutionPolicy Bypass -File install.ps1
param(
  [string]$PluginSource = (Join-Path $PSScriptRoot '..'),   # plugins/repeat-stream-guard
  [string]$ProfileRoot   = '',                              # defaults to $env:DSH_HOME or ~\.dsh
  [string]$ProfileName   = 'web'
)

$ErrorActionPreference = 'Stop'

# ---------- sanity: artifacts must be present before install (fail-loud guard) ----------
if (-not (Test-Path (Join-Path $PluginSource 'lib\index.js'))) { throw "missing lib/index.js under $PluginSource" }
if (-not (Test-Path (Join-Path $PluginSource 'lib\client.js'))) { throw "missing lib/client.js under $PluginSource (the web tree fails to start without it)" }
if (-not (Test-Path (Join-Path $PluginSource 'cordis.patch.yml'))) { throw "missing cordis.patch.yml under $PluginSource (without it the bundle contributes no row)" }
# A patch whose top level is not a list, or whose insert carries no id, is a FATAL
# start-up error for the WHOLE profile - so check the shape now, not after a restart.
$patchPath = Join-Path $PluginSource 'cordis.patch.yml'
$patchText = [System.IO.File]::ReadAllText($patchPath)
if ($patchText -notmatch '(?m)^-\s+insert:') { throw "cordis.patch.yml has no top-level '- insert:' operation: $patchPath" }
if ($patchText -notmatch [regex]::Escape('- id: repeat-stream-guard')) { throw "cordis.patch.yml does not insert the id 'repeat-stream-guard': $patchPath" }

# ---------- locate profile ----------
if (-not $ProfileRoot) {
  if ($env:DSH_HOME) { $ProfileRoot = $env:DSH_HOME } else { $ProfileRoot = Join-Path $HOME '.dsh' }
}
$PluginSource = (Resolve-Path $PluginSource).Path
$profileDir = Join-Path $ProfileRoot "profiles\$ProfileName"
if (-not (Test-Path (Join-Path $profileDir 'cordis.patch.yml'))) {
  throw "profile not found: $profileDir (expected a DSH_HOME layout; is '$ProfileName' the right profile?)"
}
$dest = Join-Path $ProfileRoot "profiles\$ProfileName\node_modules\@dsh-user\repeat-stream-guard"

Write-Host "source : $PluginSource"
Write-Host "profile: $profileDir"

# ---------- 1. link the package into the profile ----------
$RepoRoot = (Resolve-Path (Join-Path $PluginSource '..\..')).Path
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if (-not $pnpm) { throw 'pnpm is not on PATH; `dsh plugin` needs it to link the package into the profile' }
$pnpmExe = $pnpm.Source
if ($pnpmExe -like '*.ps1') {
  # Invoking the .ps1 shim fails under the default execution policy on Windows.
  $cmd = [System.IO.Path]::ChangeExtension($pnpmExe, '.cmd')
  if (Test-Path $cmd) { $pnpmExe = $cmd }
}
Push-Location $RepoRoot
# pnpm echoes the command it runs to stderr, which PowerShell turns into an error
# record; with $ErrorActionPreference = 'Stop' that would abort a run that actually
# succeeded. Capture the exit code instead and judge by it.
$prevAddEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $addOut = (& $pnpmExe dsh plugin --profile $ProfileName add $PluginSource 2>&1 | Out-String)
  $addExit = $LASTEXITCODE
} finally {
  Pop-Location
  $ErrorActionPreference = $prevAddEap
}
if ($addExit -ne 0) {
  Write-Host ''
  Write-Host 'dsh plugin add FAILED:' -ForegroundColor Red
  Write-Host $addOut
  exit 1
}
Write-Host 'package linked into the profile'

# ---------- dependency link ----------
# The profile installs this package as a junction back to this checkout, and Node
# resolves a junction to its REAL path by default. The plugin's own dependencies
# (@deepseek-ai/*, zod) live in the profile's node_modules, which is NOT on the
# search path from the checkout - so without this link the profile fails to boot
# with "Cannot find package '...' imported from <checkout>/lib/index.js".
# The path is gitignored; it is a junction, not a copy.
$depsLink = Join-Path $PluginSource 'node_modules'
$profileModules = Join-Path $ProfileRoot 'profiles\node_modules'
if (-not (Test-Path $depsLink)) {
  if (Test-Path $profileModules) {
    New-Item -ItemType Junction -Path $depsLink -Target $profileModules -ErrorAction Stop | Out-Null
    Write-Host "linked plugin dependencies: $depsLink -> $profileModules"
  } else {
    Write-Warning "no dependency tree at $profileModules; the plugin will fail to boot if it imports a package the checkout does not provide"
  }
}

# ---------- 2. load check ----------
# Probe it the way the profile does: a script inside the profile directory resolves
# the package by NAME, through its exports map, with the profile's own node_modules
# on the search path. An import that merely succeeds also proves little - a module
# exporting nothing imports cleanly and only fails at mount ("plugin.apply is not a
# function") - so assert the plugin contract as well.
$probe = Join-Path $profileDir "_dsh-loadcheck-repeat-stream-guard.mjs"
$probeJs = @'
import * as m from '@dsh-user/repeat-stream-guard'
if (typeof m.apply !== 'function') throw new Error('the package does not export apply()')
if (m.inject !== undefined && !Array.isArray(m.inject)) throw new Error('inject must be an array when present')
console.log('LOADCHECK-OK')
'@
[System.IO.File]::WriteAllText($probe, $probeJs, (New-Object System.Text.UTF8Encoding($false)))
$prevEap = $ErrorActionPreference
$prevOut = [Console]::OutputEncoding
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# No --preserve-symlinks on purpose: the real boot resolves the junction to this
# checkout path, so this probe must not paper over a dependency that cannot be found.
$loadCheck = (& node $probe 2>&1 | Out-String)
$loadExit = $LASTEXITCODE
[Console]::OutputEncoding = $prevOut
$ErrorActionPreference = $prevEap
Remove-Item $probe -Force -ErrorAction SilentlyContinue
if ($loadExit -ne 0 -or -not ($loadCheck -match 'LOADCHECK-OK')) {
  Write-Host ''
  Write-Host 'load check FAILED - do NOT restart dsh web until this is fixed:' -ForegroundColor Red
  Write-Host $loadCheck
  exit 1
}
Write-Host 'load check passed: the installed plugin module imports cleanly'

# ---------- 3. browser half parses as a script ----------
$clientCjs = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-repeat-stream-guard-client-$PID.cjs"
Copy-Item (Join-Path $dest 'lib/client.js') $clientCjs -Force
$ErrorActionPreference = 'Continue'
$clientSyntax = (& node --check $clientCjs 2>&1 | Out-String)
$clientExit = $LASTEXITCODE
Remove-Item $clientCjs -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = $prevEap
if ($clientExit -ne 0) {
  Write-Host ''
  Write-Host 'client.js is not valid as a browser half (no import/export, no top-level await):' -ForegroundColor Red
  Write-Host $clientSyntax
  exit 1
}
Write-Host 'client.js parses as a browser half'

Write-Host ''
# The pre-junction installer copied the package into profiles\node_modules\@dsh-user\<name>.
# That copy is no longer used - the profile resolves the package from its own tree - and for
# dsh-godot-bridge it contains an uninstaller that deletes recursively. Report it instead of
# removing it: the path is outside this package, and it may hold a version somebody wants.
$legacy = Join-Path $ProfileRoot "profiles\node_modules\@dsh-user\repeat-stream-guard"
if (Test-Path $legacy) {
  $legacyIsLink = [bool]((Get-Item $legacy -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  if (-not $legacyIsLink) {
    Write-Host ''
    Write-Host "note: a legacy copy of this package is still on disk: $legacy" -ForegroundColor Yellow
    Write-Host '      nothing resolves through it any more; delete it by hand when convenient.'
  }
}
Write-Host 'installed. Restart `dsh web` to activate (a running instance keeps its host rows).'
Write-Host 'verify: the settings page shows the repeat-guard switch, and a model stream that falls into a periodic loop is cut short.'
