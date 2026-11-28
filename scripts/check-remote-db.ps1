# Read-only connection test for the live database (dir_v3).
# It asks for the details itself, so no password is typed into chat or saved to disk.
# It only runs SELECT queries: row counts and the migrations that are applied.
#
# Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\check-remote-db.ps1

param([string]$LogPath)

$ErrorActionPreference = 'Stop'

$dbHost = Read-Host 'Database host (Enter = 95.216.113.194)'
if (-not $dbHost) { $dbHost = '95.216.113.194' }
$dbPort = Read-Host 'Port (Enter = 5432)'
if (-not $dbPort) { $dbPort = '5432' }
$dbName = Read-Host 'Database name (Enter = dir_v3)'
if (-not $dbName) { $dbName = 'dir_v3' }
$dbUser = Read-Host 'Database user'
$secure = Read-Host 'Database password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
    # Passed to node only through environment variables for this process.
    $env:CHK_HOST = $dbHost
    $env:CHK_PORT = $dbPort
    $env:CHK_DB   = $dbName
    $env:CHK_USER = $dbUser
    $env:CHK_PASS = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    # The output never contains the password, so it is safe to save for review.
    $ErrorActionPreference = 'Continue'
    if ($LogPath) { node scripts\check-remote-db.js 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $LogPath } else { node scripts\check-remote-db.js }
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:CHK_PASS, Env:CHK_USER, Env:CHK_HOST, Env:CHK_PORT, Env:CHK_DB -ErrorAction SilentlyContinue
}
