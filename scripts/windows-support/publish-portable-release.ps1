[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateDirectory,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [string]$ReleaseNotes = '',

  [bool]$Mandatory = $false,

  [string]$OssCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\oss-release.json'),

  [string]$SshCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\aiwxxx-production-ssh.json'),

  [string]$OssutilPath = (Join-Path $env:TEMP 'uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe'),

  [string]$OssProxy = '',

  [switch]$OverwriteExistingOssObjects,

  [switch]$AllowUnsignedWindowsCandidate,

  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$publisher = Join-Path $PSScriptRoot 'publish-disabled-release-stage.ps1'
if (-not (Test-Path -LiteralPath $publisher -PathType Leaf)) {
  throw "Disabled-stage publisher is missing: $publisher"
}

$arguments = @{
  WindowsCandidateDirectory = $CandidateDirectory
  WindowsOnly = $true
  Version = $Version
  Commit = $Commit
  ReleaseNotes = $ReleaseNotes
  Mandatory = $Mandatory
  OssCredentialPath = $OssCredentialPath
  SshCredentialPath = $SshCredentialPath
  OssutilPath = $OssutilPath
  OssProxy = $OssProxy
  OverwriteExistingOssObjects = $OverwriteExistingOssObjects
  AllowUnsignedWindowsCandidate = $AllowUnsignedWindowsCandidate
  ValidateOnly = $ValidateOnly
}

& $publisher @arguments
exit $LASTEXITCODE
