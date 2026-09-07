# session-preset-migrate — PowerShell 包装（转发给 migrate.mjs）
# 用法: .\migrate.ps1 list | inject <id> <preset> [--dry-run] | verify <id> | restore <备份目录>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Get-Command node -ErrorAction Stop | Select-Object -ExpandProperty Source
& $node "$here\migrate.mjs" @args
exit $LASTEXITCODE
