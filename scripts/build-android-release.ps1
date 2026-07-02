param(
  [switch]$PrebuildClean,
  [switch]$VerifyOnly,
  [switch]$SkipCertPrint
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $projectRoot '.env.signing.local'
$exampleEnvFile = Join-Path $projectRoot '.env.signing.local.example'
$androidDir = Join-Path $projectRoot 'android'
$gradlew = Join-Path $androidDir 'gradlew.bat'
$keystore = Join-Path $projectRoot 'nickelbrandt.keystore'
$aabPath = Join-Path $projectRoot 'android\app\build\outputs\bundle\release\app-release.aab'

$requiredVars = @(
  'NICKELBRANDT_KEYSTORE_PASSWORD',
  'NICKELBRANDT_KEY_ALIAS',
  'NICKELBRANDT_KEY_PASSWORD'
)

function Load-DotEnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing $Path. Copy $exampleEnvFile to .env.signing.local and fill in the real signing values."
  }

  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) {
      continue
    }

    if ($line.StartsWith('export ')) {
      $line = $line.Substring(7).Trim()
    }

    if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      throw "Invalid line in ${Path}: $rawLine"
    }

    $name = $Matches[1]
    $value = $Matches[2].Trim()

    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

function Assert-RequiredEnvironment {
  $missing = @()

  foreach ($name in $requiredVars) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
      $missing += $name
    }
  }

  if ($missing.Count -gt 0) {
    throw "Missing signing environment variable(s): $($missing -join ', '). Check .env.signing.local."
  }
}

function Assert-FileExists {
  param(
    [string]$Path,
    [string]$Message
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw $Message
  }
}

if (-not $VerifyOnly) {
  Write-Host 'Loading Android signing environment from .env.signing.local'
  Load-DotEnvFile -Path $envFile
  Assert-RequiredEnvironment
  Assert-FileExists -Path $keystore -Message "Missing keystore: $keystore"
}

if ($PrebuildClean) {
  Write-Host 'Running Android prebuild (--clean)'
  Push-Location $projectRoot
  try {
    & npx expo prebuild --platform android --clean
    if ($LASTEXITCODE -ne 0) {
      throw "expo prebuild failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

Assert-FileExists -Path $gradlew -Message "Missing Gradle wrapper: $gradlew. Run npm run android:prebuild:clean first if android/ has not been generated."

if (-not $VerifyOnly) {
  Write-Host 'Building Android release AAB'
  Push-Location $androidDir
  try {
    & $gradlew bundleRelease
    if ($LASTEXITCODE -ne 0) {
      throw "Gradle bundleRelease failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

Assert-FileExists -Path $aabPath -Message "Expected AAB was not found: $aabPath"
Write-Host "AAB ready: $aabPath"

if (-not $SkipCertPrint) {
  $keytool = $null
  if ($env:JAVA_HOME) {
    $javaHomeKeytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (Test-Path -LiteralPath $javaHomeKeytool) {
      $keytool = $javaHomeKeytool
    }
  }

  if (-not $keytool) {
    $keytool = 'keytool'
  }

  Write-Host 'AAB signing certificate:'
  & $keytool -printcert -jarfile $aabPath
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'keytool certificate verification failed or keytool is not available.'
  }
}
