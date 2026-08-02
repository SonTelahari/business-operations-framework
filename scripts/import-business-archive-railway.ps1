param(
  [string]$ArchivePath = '',
  [string]$OwnerName = 'William Winther',
  [string]$GuiService = 'business-operations-gui',
  [string]$PostgresService = 'Postgres',
  [string]$RailwayPath = '',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host "Railway import failed: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close this window'
  exit 1
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $ArchivePath) {
  $archive = Get-ChildItem (Join-Path $repositoryRoot 'exports\*.business-archive.json') |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($archive) { $ArchivePath = $archive.FullName }
}
if (-not $ArchivePath -or -not (Test-Path -LiteralPath $ArchivePath)) {
  throw 'No business archive was found. Pass -ArchivePath or create an export first.'
}
if (-not $RailwayPath -or -not (Test-Path -LiteralPath $RailwayPath)) {
  $railway = Get-Command railway -ErrorAction SilentlyContinue
  if ($railway) { $RailwayPath = $railway.Source }
}
if (-not $RailwayPath -or -not (Test-Path -LiteralPath $RailwayPath)) {
  throw 'Railway CLI was not found. Pass -RailwayPath to this script.'
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $NodePath = $node.Source }
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
  throw 'Node.js 20 or newer was not found. Pass -NodePath to this script.'
}

Push-Location $repositoryRoot
try {
  $env:BUSINESS_ARCHIVE_PATH = (Resolve-Path -LiteralPath $ArchivePath).Path
  & $NodePath 'scripts\import-business-archive.js'
  if ($LASTEXITCODE -ne 0) { throw "Archive validation exited with code $LASTEXITCODE." }

  $credential = Get-Credential -UserName $OwnerName -Message 'Choose the NEW owner password for the hosted framework. It will not be saved.'
  if (-not $credential) { throw 'The import was cancelled before credentials were entered.' }
  $ownerPassword = $credential.GetNetworkCredential().Password
  if ($ownerPassword.Length -lt 10 -or $ownerPassword.Length -gt 128) {
    throw 'The owner password must contain between 10 and 128 characters.'
  }

  $postgresVariables = (& $RailwayPath variable list --service $PostgresService --json | Out-String) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $postgresVariables.DATABASE_PUBLIC_URL) {
    throw 'Railway did not return the PostgreSQL public connection URL.'
  }
  try {
    $publicDatabaseUri = [Uri]([string]$postgresVariables.DATABASE_PUBLIC_URL)
  } catch {
    throw 'Railway returned an invalid PostgreSQL public connection URL. Create a temporary TCP proxy for the database and try again.'
  }
  if (-not $publicDatabaseUri.Host -or $publicDatabaseUri.Port -le 0) {
    throw 'Railway PostgreSQL has no active public TCP proxy. Create a temporary proxy for port 5432, run the import, then remove the proxy.'
  }
  $guiVariables = (& $RailwayPath variable list --service $GuiService --json | Out-String) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or ([string]$guiVariables.AUTH_SESSION_SECRET).Length -lt 32) {
    throw 'Railway did not return a valid GUI session secret.'
  }

  $env:DATABASE_URL = $postgresVariables.DATABASE_PUBLIC_URL
  $env:AUTH_SESSION_SECRET = $guiVariables.AUTH_SESSION_SECRET
  $env:IMPORT_OWNER_NAME = $credential.UserName
  $env:IMPORT_OWNER_PASSWORD = $ownerPassword
  $env:IMPORT_ACTOR = 'secure-railway-import'

  $resultPath = Join-Path $repositoryRoot 'outputs\railway-business-import-result.json'
  & $NodePath 'scripts\import-business-archive.js' '--commit' | Tee-Object -FilePath $resultPath
  if ($LASTEXITCODE -ne 0) { throw "Archive import exited with code $LASTEXITCODE." }
  Write-Host ''
  Write-Host "Business workspace imported successfully. Result: $resultPath" -ForegroundColor Green
} finally {
  $env:BUSINESS_ARCHIVE_PATH = $null
  $env:DATABASE_URL = $null
  $env:AUTH_SESSION_SECRET = $null
  $env:IMPORT_OWNER_NAME = $null
  $env:IMPORT_OWNER_PASSWORD = $null
  $env:IMPORT_ACTOR = $null
  $ownerPassword = $null
  $credential = $null
  Pop-Location
}

Read-Host 'Press Enter to close this window'
