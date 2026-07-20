[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$binDirectory = Join-Path $PSScriptRoot 'bin\win32-x64'
$executablePath = Join-Path $binDirectory 'ecomet-mcp.exe'
$archivePath = Join-Path $binDirectory 'ecomet-mcp-win32-x64.zip'
$checksumPath = "$executablePath.sha256"

if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw 'ECOMET_MCP_CHECKSUM_MISSING: reinstall the e-Comet plugin.'
}

$expectedChecksum = ((Get-Content -Raw -LiteralPath $checksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
$hasValidExecutable =
    (Test-Path -LiteralPath $executablePath -PathType Leaf) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $executablePath).Hash.ToLowerInvariant() -eq $expectedChecksum)

if ($hasValidExecutable) {
    return
}

if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'ECOMET_MCP_BINARY_MISSING: reinstall the e-Comet plugin.'
}

New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $binDirectory -Force

$actualChecksum = (Get-FileHash -Algorithm SHA256 -LiteralPath $executablePath).Hash.ToLowerInvariant()
if ($actualChecksum -ne $expectedChecksum) {
    Remove-Item -Force -LiteralPath $executablePath -ErrorAction SilentlyContinue
    throw 'ECOMET_MCP_CHECKSUM_MISMATCH: reinstall the e-Comet plugin.'
}
