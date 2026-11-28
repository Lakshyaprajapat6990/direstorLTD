# Sets up a NEW, EMPTY server database from this PC:
#   1. creates all tables (prisma migrate deploy)
#   2. copies companies + directors from the local dev DB (scripts/copy-tables.js)
#   3. creates the first Super Admin (you type the email and password)
# You type the database password here; it is never saved to disk or printed.
#
#   powershell -ExecutionPolicy Bypass -File scripts\copy-local-to-remote.ps1 [-LogPath file]

param([string]$LogPath)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Write-Log([string]$m) { Write-Host $m; if ($LogPath) { Add-Content -Path $LogPath -Value $m } }

$dbHost = Read-Host 'Server database host (Enter = 95.216.113.194)'; if (-not $dbHost) { $dbHost = '95.216.113.194' }
$dbPort = Read-Host 'Port (Enter = 5432)'; if (-not $dbPort) { $dbPort = '5432' }
$dbName = Read-Host 'Database name'
$dbUser = Read-Host 'Database user'
$secure = Read-Host 'Database password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
    $pw = [Uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
    $u = [Uri]::EscapeDataString($dbUser)
    # Process-only variable: overrides .env for every command below, gone when the window closes.
    $env:DATABASE_URL = "postgresql://${u}:${pw}@${dbHost}:${dbPort}/${dbName}?connect_timeout=20"
    Remove-Variable pw

    Write-Log "== Target: ${dbHost}:${dbPort}/${dbName} (user $dbUser)"
    $go = Read-Host "Create tables and copy local data into this database? Type YES"
    if ($go -ne 'YES') { Write-Log 'Cancelled.'; return }

    Write-Log '== Step 1/3: creating tables'
    npx prisma migrate deploy 2>&1 | ForEach-Object { Write-Log "$_" }
    if ($LASTEXITCODE -ne 0) { Write-Log 'STEP 1 FAILED'; return }

    Write-Log '== Step 2/3: copying companies and directors'
    node scripts/copy-tables.js 2>&1 | ForEach-Object { Write-Log "$_" }
    if ($LASTEXITCODE -ne 0) { Write-Log 'STEP 2 FAILED'; return }

    Write-Log '== Step 3/3: create the Super Admin (type your email and a NEW password)'
    npx tsx scripts/bootstrap-super-admin.ts
    Write-Log "== Super Admin step exit code: $LASTEXITCODE"
    Write-Log '== ALL DONE'
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}
