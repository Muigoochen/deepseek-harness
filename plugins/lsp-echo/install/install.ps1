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
# The machine config lives inside $dest, so keep its content across the wipe:
# reinstalling must not silently drop a hand-edited editorPort/attachEditor or
# the godotBin this machine was set up with.
$machineConfig = Join-Path $dest 'checkers\godot-lsp\godot-lsp.config.json'
$previousConfig = ''
# Read and write UTF-8 explicitly: Get-Content's default encoding under
# PowerShell 5.1 is the ANSI code page, so a config holding any non-ASCII path
# would come back re-encoded and be written out corrupted.
if (Test-Path $machineConfig) { $previousConfig = [System.IO.File]::ReadAllText($machineConfig) }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'checkers') | Out-Null
Copy-Item (Join-Path $PluginSource 'package.json') (Join-Path $dest 'package.json') -Force
Copy-Item (Join-Path $PluginSource 'README.md') (Join-Path $dest 'README.md') -Force
Copy-Item (Join-Path $PluginSource 'lib\*.js') (Join-Path $dest 'lib\') -Force
# One JSON dictionary per language sits beside the host half; the browser fetches
# them through the API, and `lib\*.js` alone would leave them out of the install.
if (Test-Path (Join-Path $PluginSource 'lib\locales')) {
  Copy-Item (Join-Path $PluginSource 'lib\locales') (Join-Path $dest 'lib\locales') -Recurse -Force
} else {
  Write-Warning "locale dictionaries missing from source: $(Join-Path $PluginSource 'lib\locales')"
}
# Every bundled engine, discovered rather than named. A fixed engine id here
# silently omitted engines added later: a project could bind one (its config comes
# from elsewhere) while the plugin never shipped it, leaving a chip with no
# extensions, no diagnostics, and no clue why.
$checkersSource = Join-Path $PluginSource 'checkers'
$engineNames = @()
foreach ($d in (Get-ChildItem $checkersSource -Directory -ErrorAction SilentlyContinue)) {
  if (-not (Test-Path (Join-Path $d.FullName 'engine.json'))) { continue }
  Copy-Item $d.FullName (Join-Path (Join-Path $dest 'checkers') $d.Name) -Recurse -Force
  $engineNames += $d.Name
}
if (-not $engineNames.Count) { throw "no engine found under $checkersSource (each engine needs engine.json)" }
Write-Host ("installed engines: " + ($engineNames -join ', '))

# ---------- 2. machine-local bridge config (only when missing) ----------
if ($previousConfig) {
  Write-TextNoBom -Path $machineConfig -Text $previousConfig
  Write-Host "restored existing machine config: $machineConfig"
} elseif (-not (Test-Path $machineConfig)) {
  if (-not $GodotBin) {
    try { $GodotBin = (Get-Command godot -ErrorAction Stop).Source } catch { $GodotBin = '' }
  }
  if (-not $Project) {
    $localDev = Join-Path (Join-Path $PluginSource 'checkers\godot-lsp') 'godot-lsp.config.local-dev.json'
    # ReadAllText, not Get-Content: PowerShell 5.1 decodes with the ANSI code page
    # by default, and this file carries non-ASCII text — the JSON would come back
    # corrupted and ConvertFrom-Json would throw (the throw is caught below, so the
    # damage surfaces only as a silently empty defaultProject).
    if (Test-Path $localDev) {
      try { $Project = ([System.IO.File]::ReadAllText($localDev) | ConvertFrom-Json).defaultProject } catch { $Project = '' }
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
# ReadAllText, not Get-Content -Raw: 5.1's default ANSI decoding would re-encode
# any non-ASCII path in this file when it is written back below.
$content = [System.IO.File]::ReadAllText($patchFile)
if ($content -match [regex]::Escape($needle)) {
  Write-Host "patch row already present: $patchFile"
} else {
  # Without a project path the row must not carry a `projects:` list: an empty
  # `path: ''` passes the plugin's schema, is dropped while seeding, and leaves
  # the plugin running with zero projects — a silent no-op install.
  $row = if ($Project) {
    # A single quote inside the path would close the YAML scalar early.
    $quoted = $Project.Replace("'", "''")
    @"
- insert:
    - id: lsp-echo
      name: '@dsh-user/lsp-echo'
      config:
        projects:
          - path: '${quoted}'
"@
  } else {
    Write-Warning "no project path given (pass -Project, or set defaultProject in godot-lsp.config.local-dev.json); writing the lsp-echo row with no projects list"
    @"
- insert:
    - id: lsp-echo
      name: '@dsh-user/lsp-echo'
"@
  }
  $content = $content.TrimEnd() + "`r`n" + $row + "`r`n"
  Write-TextNoBom -Path $patchFile -Text $content
  Write-Host "appended lsp-echo row to: $patchFile"
}

# ---------- 4. load check ----------
# The plugin builds its settings schema at module top level, so a schema mistake
# throws on import and takes the whole `dsh web` boot down with it. Import the
# installed copy here instead: a broken install then fails during install, with
# the error in front of whoever just ran the script, instead of at the next GUI
# restart. Schema edits are the likely culprit — this fork's schemastery has no
# `.optional()`; a field is optional unless marked `.required()`.
$entry = Join-Path $dest 'lib/index.js'
# A failing import writes its stack to stderr, which PowerShell surfaces as an
# error record and would stop on; capture it as plain text and report it here.
# Node writes UTF-8, so the console encoding is set for the call as well --
# otherwise non-ASCII text in the reported error comes back mangled.
$prevEap = $ErrorActionPreference
$prevOut = [Console]::OutputEncoding
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$loadCheck = (& node --input-type=module -e "await import('file:///' + process.argv[1].replace(/\\/g, '/')); console.log('LOADCHECK-OK')" $entry 2>&1 | Out-String)
$loadExit = $LASTEXITCODE
[Console]::OutputEncoding = $prevOut
$ErrorActionPreference = $prevEap
if ($loadExit -ne 0 -or -not ($loadCheck -match 'LOADCHECK-OK')) {
  Write-Host ''
  Write-Host 'load check FAILED - do NOT restart dsh web until this is fixed:' -ForegroundColor Red
  Write-Host $loadCheck
  exit 1
}
Write-Host 'load check passed: the installed plugin module imports cleanly'

# ---------- 5. browser half + dictionaries ----------
# Neither failure is caught above: the browser half is loaded by the page rather
# than by this host import, so its syntax error surfaces as a blank settings card;
# and an unreadable or key-mismatched dictionary degrades silently to showing raw
# keys. Check both here, where the cause is still in front of the installer.
$clientEntry = Join-Path $dest 'lib/client.js'
$localeDir = Join-Path $dest 'lib/locales'
$checks = @()
# The browser half is handed to the page verbatim and may only `require` the React
# seed. Checking the installed .js with `node --check` would honour package.json's
# "type": "module" and therefore ACCEPT an `import` — the one mistake that breaks
# the zero-build contract. Parse a .cjs copy instead, so ESM syntax fails here.
$clientCjs = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-lsp-echo-client-$PID.cjs")
Copy-Item $clientEntry $clientCjs -Force
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$clientSyntax = (& node --check $clientCjs 2>&1 | Out-String)
$clientExit = $LASTEXITCODE
Remove-Item $clientCjs -Force -ErrorAction SilentlyContinue
if ($clientExit -ne 0) { $checks += "client.js is not valid as a browser half (it is handed to the page as-is, so it may only require the platform seed; no import/export, no top-level await):`n$clientSyntax" }
# The dictionary check runs from a file: PowerShell strips the double quotes in a
# single-quoted `node -e '...'` argument before the child sees it, so an inline
# script arrives mangled ("import fs from node:fs") and fails for the wrong reason.
$dictCheckScript = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-lsp-echo-i18n-check-$PID.mjs"
$dictCheckSource = @'
import fs from 'node:fs'
import path from 'node:path'
const dir = process.argv[2]
const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'))
let zh, en
try { zh = read('zh'); en = read('en') } catch (e) { console.log('dictionary unreadable: ' + e.message); process.exit(1) }
// A value is a string, or an array of strings for a message split into paragraphs.
// Anything else (a number, an object, an array with a non-string inside) survives
// the key/type comparison below and only shows up as "[object Object]" on screen.
const shape = (v) => Array.isArray(v)
  ? (v.every((x) => typeof x === 'string') ? 'paragraphs' : 'bad')
  : (typeof v === 'string' ? 'string' : 'bad')
const bad = []
for (const k of Object.keys(zh)) {
  if (shape(zh[k]) === 'bad') bad.push('zh value is neither a string nor a string array: ' + k)
  if (!(k in en)) { bad.push('missing in en: ' + k); continue }
  if (shape(zh[k]) === 'bad') continue
  if (shape(en[k]) === 'bad') bad.push('en value is neither a string nor a string array: ' + k)
  else if (shape(zh[k]) !== shape(en[k])) bad.push('paragraph mismatch: ' + k)
}
for (const k of Object.keys(en)) {
  if (!(k in zh)) bad.push('missing in zh: ' + k)
  else if (shape(en[k]) === 'bad') bad.push('en value is neither a string nor a string array: ' + k)
}
if (bad.length) { console.log(bad.join('; ')); process.exit(1) }
console.log('keys=' + Object.keys(zh).length)
'@
Write-TextNoBom -Path $dictCheckScript -Text $dictCheckSource
$dictCheck = (& node $dictCheckScript $localeDir 2>&1 | Out-String)
$dictExit = $LASTEXITCODE
Remove-Item $dictCheckScript -Force -ErrorAction SilentlyContinue
if ($dictExit -ne 0) { $checks += "dictionaries:`n$dictCheck" }
[Console]::OutputEncoding = $prevOut
$ErrorActionPreference = $prevEap
if ($checks.Count) {
  Write-Host ''
  Write-Host 'post-install checks FAILED - do NOT restart dsh web until this is fixed:' -ForegroundColor Red
  foreach ($c in $checks) { Write-Host $c }
  exit 1
}
Write-Host ("client.js and dictionaries OK (" + $dictCheck.Trim() + ")")

# ---------- 6. every referenced i18n key exists ----------
# A key used in code but absent from a dictionary degrades to displaying the raw
# key in the GUI — silently, and only on the language that lacks it. Checked from
# the SOURCE tree, not the installed copy, so a stale install cannot mask it.
$keyCheckScript = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-lsp-echo-key-check-$PID.mjs"
$keyCheckSource = @'
import fs from 'node:fs'
import path from 'node:path'
const src = process.argv[2]
const zh = JSON.parse(fs.readFileSync(path.join(src, 'lib/locales/zh.json'), 'utf8'))
const en = JSON.parse(fs.readFileSync(path.join(src, 'lib/locales/en.json'), 'utf8'))
const used = new Map()
const CALL = /\b(?:t|T|tLine|tParts|renderParts|noteOf)\(\s*['"]([^'"]+)['"]/g
// A concatenated key (`t('a.' + x)`) is not a literal and must not be reported as
// missing — the key set it resolves to is not knowable here.
const CONCAT = /\b(?:t|T|tLine|tParts|renderParts|noteOf)\(\s*['"][^'"]+['"]\s*\+/
// addon.js is included because its error strings travel to the GUI as JSON and are
// shown verbatim; it was outside this scan when its text was still hardcoded.
for (const rel of ['lib/client.js', 'lib/index.js', 'lib/addon.js']) {
  const lines = fs.readFileSync(path.join(src, rel), 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (CONCAT.test(lines[i])) continue
    CALL.lastIndex = 0
    let m
    while ((m = CALL.exec(lines[i])) !== null) {
      if (!used.has(m[1])) used.set(m[1], [])
      used.get(m[1]).push(rel + ':' + (i + 1))
    }
  }
}
const bad = []
for (const k of used.keys()) {
  if (!(k in zh)) bad.push('missing in zh: ' + k + '  <- ' + used.get(k).join(', '))
  else if (!(k in en)) bad.push('missing in en: ' + k + '  <- ' + used.get(k).join(', '))
}
const unused = Object.keys(zh).filter((k) => !used.has(k))
if (bad.length) { console.log(bad.join('\n')); process.exit(1) }
console.log('referenced=' + used.size + ' zh=' + Object.keys(zh).length + ' en=' + Object.keys(en).length)
// Dead keys and name/content mismatches are not failures — they are cleanup
// signals, so they are reported without failing the install.
if (unused.length) console.log('UNUSED (' + unused.length + ', consider removing): ' + unused.join(', '))
'@
Write-TextNoBom -Path $keyCheckScript -Text $keyCheckSource
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$keyCheck = (& node $keyCheckScript $PluginSource 2>&1 | Out-String)
$keyExit = $LASTEXITCODE
Remove-Item $keyCheckScript -Force -ErrorAction SilentlyContinue
[Console]::OutputEncoding = $prevOut
$ErrorActionPreference = $prevEap
if ($keyExit -ne 0) {
  Write-Host ''
  Write-Host 'i18n key check FAILED - do NOT restart dsh web until this is fixed:' -ForegroundColor Red
  Write-Host $keyCheck
  exit 1
}
Write-Host ("i18n keys OK (" + $keyCheck.Trim() + ")")

Write-Host ''
Write-Host 'installed. Restart `dsh web` to activate (a running instance keeps its host rows).'
Write-Host "verify later with: node `"$dest`/checkers/godot-lsp/godot-lsp.mjs`" smoke <projectFile>"
