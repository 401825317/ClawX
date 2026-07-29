[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,

  [string]$CredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\live-registration-admin.json'),

  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'

function ConvertTo-WindowsCommandLineArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append(('\' * ($backslashes * 2)))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..\..')).Path
$resolvedZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$resolvedCredentialPath = (Resolve-Path -LiteralPath $CredentialPath).Path

if ($resolvedCredentialPath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Live registration credentials must be stored outside the Git repository.'
}
if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
  $NodePath = $nodeCommand.Source
}
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath).Path
$regressionScript = Join-Path $scriptRoot 'run-packaged-regression.mjs'

$credential = Get-Content -Raw -LiteralPath $resolvedCredentialPath | ConvertFrom-Json
if ([int]$credential.schemaVersion -ne 1 -or -not $credential.recordDpapi) {
  throw 'Live registration credential file must contain schemaVersion=1 and recordDpapi.'
}

$recordPointer = [IntPtr]::Zero
$recordJson = $null
try {
  $secureRecord = ConvertTo-SecureString ([string]$credential.recordDpapi)
  $recordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureRecord)
  $decryptedRecord = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($recordPointer)
  $record = $decryptedRecord | ConvertFrom-Json
  if (-not ([string]$record.username).Trim() -or -not ([string]$record.password)) {
    throw 'The DPAPI live registration record must contain username and password.'
  }
  $recordJson = [pscustomobject]@{
    username = [string]$record.username
    password = [string]$record.password
  } | ConvertTo-Json -Compress

  $arguments = @(
    $regressionScript,
    '--zip',
    $resolvedZipPath,
    '--profile',
    'live',
    '--live-register-admin-stdin'
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $resolvedNodePath
  $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' '
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $startInfo.RedirectStandardInput = $true

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw 'Failed to start the packaged Live registration process.'
  }
  $process.StandardInput.WriteLine($recordJson)
  $process.StandardInput.Close()
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) {
    throw "Packaged Live registration gate failed with exit code $exitCode."
  }
  Write-Output 'UCLAW_LIVE_REGISTRATION_GATE_OK'
}
finally {
  if ($recordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($recordPointer)
  }
  if ($record) {
    $record.username = ''
    $record.password = ''
  }
  $decryptedRecord = $null
  $recordJson = $null
}
