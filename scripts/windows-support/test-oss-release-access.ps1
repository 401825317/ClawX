[CmdletBinding()]
param(
  [string]$OssCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\oss-release.json'),

  [string]$OssutilPath = (Join-Path $env:TEMP 'uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe'),

  [string]$OssProxy = '',

  [switch]$RequireEnvironmentCredentials
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Test-PathInside {
  param([string]$Child, [string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  return $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RemoteStatusCode {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [string]$Proxy = ''
  )
  $arguments = @{
    UseBasicParsing = $true
    Method = 'Head'
    Uri = $Uri
    TimeoutSec = 30
  }
  if ($Proxy) { $arguments.Proxy = $Proxy }
  try {
    $response = Invoke-WebRequest @arguments
    return [int]$response.StatusCode
  }
  catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      return [int]$_.Exception.Response.StatusCode
    }
    throw
  }
}

function Unprotect-DpapiSecret {
  param([Parameter(Mandatory = $true)][string]$ProtectedValue)
  $pointer = [IntPtr]::Zero
  $secureValue = $null
  try {
    $secureValue = ConvertTo-SecureString $ProtectedValue
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  catch {
    throw 'OSS DPAPI secret cannot be decrypted by the current Windows machine and user. Regenerate the credential locally or configure the protected GitHub Environment secrets.'
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($secureValue) { $secureValue.Dispose() }
  }
}

if (-not (Test-Path -LiteralPath $OssutilPath -PathType Leaf)) {
  throw "ossutil not found: $OssutilPath"
}

$accessKeyId = [Environment]::GetEnvironmentVariable('UCLAW_OSS_ACCESS_KEY_ID')
$accessKeySecret = [Environment]::GetEnvironmentVariable('UCLAW_OSS_ACCESS_KEY_SECRET')
$hasId = -not [string]::IsNullOrWhiteSpace($accessKeyId)
$hasSecret = -not [string]::IsNullOrWhiteSpace($accessKeySecret)

if ($hasId -xor $hasSecret) {
  throw 'UCLAW_OSS_ACCESS_KEY_ID and UCLAW_OSS_ACCESS_KEY_SECRET must be configured together.'
}
if ($RequireEnvironmentCredentials -and -not $hasId) {
  throw 'Protected Environment is missing UCLAW_OSS_ACCESS_KEY_ID and UCLAW_OSS_ACCESS_KEY_SECRET.'
}

if ($hasId) {
  $credential = [pscustomobject]@{
    accessKeyId = $accessKeyId
    bucket = 'uclaw-ver'
    region = 'cn-beijing'
    endpoint = 'oss-cn-beijing.aliyuncs.com'
    prefix = 'releases/latest/'
  }
}
else {
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path
  $resolvedCredentialPath = (Resolve-Path -LiteralPath $OssCredentialPath).Path
  if (Test-PathInside $resolvedCredentialPath $repoRoot) {
    throw 'OSS credentials must be stored outside the Git repository.'
  }
  $credential = Get-Content -Raw -LiteralPath $resolvedCredentialPath | ConvertFrom-Json
  if ([int]$credential.schemaVersion -ne 1 -or -not $credential.accessKeySecretDpapi) {
    throw 'Invalid OSS credential metadata.'
  }
  $accessKeyId = [string]$credential.accessKeyId
}

$endpoint = ([string]$credential.endpoint).Trim().ToLowerInvariant() -replace '^https?://', ''
if (
  [string]$credential.bucket -ne 'uclaw-ver' -or
  [string]$credential.region -ne 'cn-beijing' -or
  $endpoint -ne 'oss-cn-beijing.aliyuncs.com' -or
  [string]$credential.prefix -ne 'releases/latest/'
) {
  throw 'OSS credential metadata does not target the approved UClaw release location.'
}
if ([string]::IsNullOrWhiteSpace($accessKeyId)) {
  throw 'OSS access key ID is missing.'
}
if (-not $hasId) {
  $accessKeySecret = Unprotect-DpapiSecret -ProtectedValue ([string]$credential.accessKeySecretDpapi)
}
if ([string]::IsNullOrWhiteSpace($accessKeySecret)) {
  throw 'OSS access key secret is missing.'
}

$probeId = [guid]::NewGuid().ToString('N')
$objectKey = "releases/latest/.oss-probes/$probeId.json"
$objectUri = "oss://$($credential.bucket)/$objectKey"
$publicUri = "https://$($credential.bucket).$endpoint/$objectKey"
$temporaryRoot = Join-Path $env:TEMP "uclaw-oss-probe-$probeId"
$payloadPath = Join-Path $temporaryRoot 'probe.json'
$downloadPath = Join-Path $temporaryRoot 'probe.remote.json'
$commonArguments = @()
if ($OssProxy) { $commonArguments += @('--proxy', $OssProxy) }
$uploadAttempted = $false
$removed = $false
$cleanupFailure = $null
$ossEnvironmentNames = @(
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_SESSION_TOKEN',
  'OSS_ROLE_ARN',
  'OSS_ROLE_SESSION_NAME',
  'OSS_REGION',
  'OSS_ENDPOINT'
)
$previousOssEnvironment = @{}
foreach ($name in $ossEnvironmentNames) {
  $previousOssEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  [ordered]@{
    schemaVersion = 1
    purpose = 'uclaw-release-oss-write-probe'
    nonce = $probeId
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $payloadPath -Encoding UTF8

  [Environment]::SetEnvironmentVariable('OSS_ACCESS_KEY_ID', $accessKeyId, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_ACCESS_KEY_SECRET', $accessKeySecret, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_SESSION_TOKEN', $null, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_ROLE_ARN', $null, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_ROLE_SESSION_NAME', $null, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_REGION', [string]$credential.region, 'Process')
  [Environment]::SetEnvironmentVariable('OSS_ENDPOINT', $endpoint, 'Process')

  $statusBefore = Get-RemoteStatusCode -Uri $publicUri -Proxy $OssProxy
  if ($statusBefore -ne 404) {
    throw "Unexpected OSS probe collision (HTTP $statusBefore)."
  }

  $uploadAttempted = $true
  & $OssutilPath cp $payloadPath $objectUri @commonArguments
  if ($LASTEXITCODE -ne 0) { throw "OSS probe upload failed with exit code $LASTEXITCODE." }
  $uploaded = $true

  $downloadArguments = @{
    UseBasicParsing = $true
    Uri = $publicUri
    OutFile = $downloadPath
    TimeoutSec = 60
  }
  if ($OssProxy) { $downloadArguments.Proxy = $OssProxy }
  Invoke-WebRequest @downloadArguments
  $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $payloadPath).Hash
  $remoteHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash
  if ($localHash -cne $remoteHash) { throw 'OSS probe read-back SHA-256 mismatch.' }

  & $OssutilPath rm $objectUri --force @commonArguments
  if ($LASTEXITCODE -ne 0) { throw "OSS probe cleanup failed with exit code $LASTEXITCODE." }

  & $OssutilPath stat $objectUri --output-format json @commonArguments 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'OSS probe still exists after cleanup.' }
  $statusAfter = Get-RemoteStatusCode -Uri $publicUri -Proxy $OssProxy
  if ($statusAfter -ne 404) { throw "OSS probe is still publicly reachable after cleanup (HTTP $statusAfter)." }
  $removed = $true

  [pscustomobject]@{
    status = 'OSS_PROBE_OK'
    bucket = [string]$credential.bucket
    objectKey = $objectKey
    uploaded = $true
    readBackVerified = $true
    removed = $true
  } | ConvertTo-Json -Compress
}
finally {
  if ($uploadAttempted -and -not $removed) {
    & $OssutilPath rm $objectUri --force @commonArguments 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $cleanupFailure = "Probe object cleanup failed: $objectKey" }
  }
  foreach ($name in $ossEnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousOssEnvironment[$name], 'Process')
  }
  $previousOssEnvironment = $null
  $accessKeySecret = $null
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
  if ($cleanupFailure) { Write-Warning $cleanupFailure }
}
