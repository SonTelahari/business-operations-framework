param(
  [string]$LegacyAppUrl = 'https://still-water-gui-production.up.railway.app',
  [string]$AdminName = 'William Winther',
  [string]$BusinessName = 'Frontier Firearms',
  [string]$BusinessLocation = 'Van Horn',
  [string]$BusinessReferenceId = '23',
  [string]$PricingPath = '',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host "Preview export failed: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close this window'
  exit 1
}
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$credential = Get-Credential -UserName $AdminName -Message 'Enter the password for the OLD hosted business app. It will not be saved.'
if (-not $credential) {
  throw 'The export was cancelled before credentials were entered.'
}

$previous = @{}
$variableNames = @(
  'LEGACY_APP_URL',
  'LEGACY_ADMIN_NAME',
  'LEGACY_ADMIN_PASSWORD',
  'LEGACY_BUSINESS_NAME',
  'LEGACY_BUSINESS_LOCATION',
  'LEGACY_BUSINESS_REFERENCE_ID',
  'LEGACY_PRICING_PATH'
)
$variableNames | ForEach-Object { $previous[$_] = [Environment]::GetEnvironmentVariable($_, 'Process') }

try {
  $env:LEGACY_APP_URL = $LegacyAppUrl
  $env:LEGACY_ADMIN_NAME = $credential.UserName
  $env:LEGACY_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
  $env:LEGACY_BUSINESS_NAME = $BusinessName
  $env:LEGACY_BUSINESS_LOCATION = $BusinessLocation
  $env:LEGACY_BUSINESS_REFERENCE_ID = $BusinessReferenceId
  if ($PricingPath) { $env:LEGACY_PRICING_PATH = $PricingPath }

  if (-not $NodePath) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { $NodePath = $node.Source }
  }
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
    throw 'Node.js was not found. Install Node.js 20 or pass -NodePath to this script.'
  }

  Push-Location $repositoryRoot
  try {
    & $NodePath 'scripts\export-legacy-business.js'
    if ($LASTEXITCODE -ne 0) { throw "The exporter exited with code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
  Write-Host ''
  Write-Host 'Preview archive created successfully.' -ForegroundColor Green
} finally {
  $env:LEGACY_ADMIN_PASSWORD = $null
  $credential = $null
  $variableNames | ForEach-Object {
    [Environment]::SetEnvironmentVariable($_, $previous[$_], 'Process')
  }
}

Read-Host 'Press Enter to close this window'
