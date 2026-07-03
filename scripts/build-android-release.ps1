param(
  [ValidateSet('aab', 'apk')]
  [string]$Type = 'aab',
  [switch]$SkipPrebuild,
  [switch]$SkipCertPrint
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $projectRoot '.env.signing.local'
$exampleEnvFile = Join-Path $projectRoot '.env.signing.local.example'
$androidDir = Join-Path $projectRoot 'android'
$gradlew = Join-Path $androidDir 'gradlew.bat'
$keystore = Join-Path $projectRoot 'nickelbrandt.keystore'

$requiredVars = @(
  'NICKELBRANDT_KEYSTORE_PASSWORD',
  'NICKELBRANDT_KEY_ALIAS',
  'NICKELBRANDT_KEY_PASSWORD'
)

$buildConfig = @{
  aab = @{
    GradleTask = ':app:bundleRelease'
    OutputPath = Join-Path $projectRoot 'android\app\build\outputs\bundle\release\app-release.aab'
    Label = 'AAB'
  }
  apk = @{
    GradleTask = ':app:assembleRelease'
    OutputPath = Join-Path $projectRoot 'android\app\build\outputs\apk\release\app-release.apk'
    Label = 'APK'
  }
}

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

function Stop-GradleIfAvailable {
  if (-not (Test-Path -LiteralPath $gradlew)) {
    Write-Host 'No existing Gradle wrapper found; skipping Gradle stop.'
    return
  }

  Write-Host 'Stopping existing Gradle daemons'
  Push-Location $androidDir
  try {
    & $gradlew --stop
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Gradle --stop exited with code $LASTEXITCODE; continuing with clean prebuild."
    }
  } catch {
    Write-Warning "Could not stop Gradle cleanly; continuing with clean prebuild. $($_.Exception.Message)"
  } finally {
    Pop-Location
  }

  Start-Sleep -Seconds 2
}

function Invoke-CheckedCommand {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  Write-Host $Description
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Get-KeytoolCommand {
  if ($env:JAVA_HOME) {
    $javaHomeKeytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (Test-Path -LiteralPath $javaHomeKeytool) {
      return $javaHomeKeytool
    }
  }

  return 'keytool'
}

function Write-ArtifactSummary {
  param(
    [string]$Path,
    [string]$Label
  )

  $artifact = Get-Item -LiteralPath $Path
  $sizeMb = [math]::Round($artifact.Length / 1MB, 2)
  Write-Host "$Label ready: $Path"
  Write-Host "$Label size: $sizeMb MB"
}

$selectedBuild = $buildConfig[$Type]
$label = $selectedBuild.Label
$outputPath = $selectedBuild.OutputPath
$gradleTask = $selectedBuild.GradleTask

Write-Host 'Loading Android signing environment from .env.signing.local'
Load-DotEnvFile -Path $envFile
Assert-RequiredEnvironment
Assert-FileExists -Path $keystore -Message "Missing keystore: $keystore"

if (-not $SkipPrebuild) {
  Stop-GradleIfAvailable
  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand -Description 'Running Android clean prebuild' -Command {
      & npx expo prebuild --platform android --clean
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host 'Skipping Android clean prebuild'
}

Assert-FileExists -Path $gradlew -Message "Missing Gradle wrapper: $gradlew. Run without -SkipPrebuild to regenerate android/."

Push-Location $androidDir
try {
  Invoke-CheckedCommand -Description "Building Android release $label" -Command {
    & $gradlew $gradleTask
  }
} finally {
  Pop-Location
}

Assert-FileExists -Path $outputPath -Message "Expected $label was not found: $outputPath"
Write-ArtifactSummary -Path $outputPath -Label $label

if (-not $SkipCertPrint -and $Type -eq 'aab') {
  $keytool = Get-KeytoolCommand
  Write-Host "$label signing certificate:"
  & $keytool -printcert -jarfile $outputPath
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'keytool certificate verification failed or keytool is not available.'
  }
} elseif ($Type -eq 'apk') {
  Write-Host 'APK signing check: Gradle validateSigningRelease completed during :app:assembleRelease.'
}
