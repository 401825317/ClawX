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

  [string]$SshCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\production-ssh.json'),

  [string]$OssutilPath = (Join-Path $env:TEMP 'uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe'),

  [string]$PublicFeedUri = 'https://aiwxxx.com/api/clawx/updates/latest?channel=latest&platform=win&arch=x64&package_type=portable_zip',

  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$script:AskpassPath = ''
$script:SshMetadata = $null

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

function ConvertTo-SqlLiteral {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { $Value = '' }
  $sanitized = $Value.Replace([string][char]0, '').Replace("'", "''")
  return "'$sanitized'"
}

function Test-PathInside {
  param([string]$Child, [string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  return $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-PublicRelease {
  param([switch]$RequireResponse)
  try {
    $response = Invoke-RestMethod -Uri $PublicFeedUri -TimeoutSec 30
    if ($response.success -eq $true -and $response.data) {
      return $response.data
    }
    if ($response.success -eq $true) {
      return $null
    }
    if ($RequireResponse) {
      throw 'The public release feed returned an unsuccessful response.'
    }
    return $null
  }
  catch {
    if ($RequireResponse) {
      throw 'The public release feed is unavailable; production writes are blocked.'
    }
    return $null
  }
}

function Test-ReleaseMatches {
  param($Release, $Identity, [string]$ExpectedUrl)
  if (-not $Release) { return $false }
  return (
    [string]$Release.version -eq [string]$Identity.version -and
    [string]$Release.package_type -eq 'portable_zip' -and
    [string]$Release.platform -eq 'win' -and
    [string]$Release.arch -eq 'x64' -and
    [string]$Release.download_url -eq $ExpectedUrl -and
    [int64]$Release.size -eq [int64]$Identity.size -and
    [string]$Release.sha512 -ceq [string]$Identity.sha512 -and
    [bool]$Release.mandatory -eq $Mandatory
  )
}

function Get-HttpHead {
  param([string]$Uri)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $Uri -TimeoutSec 30
    return [pscustomobject]@{
      Exists = $true
      Status = [int]$response.StatusCode
      Length = [int64]$response.Headers['Content-Length']
      ContentType = [string]$response.Headers['Content-Type']
      AcceptRanges = [string]$response.Headers['Accept-Ranges']
    }
  }
  catch {
    $statusCode = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }
    if ($statusCode -eq 404) {
      return [pscustomobject]@{ Exists = $false; Status = 404; Length = 0; ContentType = ''; AcceptRanges = '' }
    }
    throw
  }
}

function Assert-RemoteZip {
  param([string]$Uri, [int64]$ExpectedSize)
  $head = Get-HttpHead $Uri
  if (-not $head.Exists -or $head.Status -ne 200) {
    throw "Published ZIP is not available: $Uri"
  }
  if ($head.Length -ne $ExpectedSize) {
    throw "Published ZIP size mismatch: expected=$ExpectedSize actual=$($head.Length)"
  }
  if ($head.AcceptRanges -ne 'bytes') {
    throw "Published ZIP does not advertise byte ranges: $($head.AcceptRanges)"
  }
  $allowedTypes = @('application/zip', 'application/x-zip-compressed', 'application/octet-stream')
  if ($allowedTypes -notcontains $head.ContentType) {
    throw "Published ZIP content type is not allowed: $($head.ContentType)"
  }

  Add-Type -AssemblyName System.Net.Http
  $client = [Net.Http.HttpClient]::new()
  try {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
    $request.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new(0, 3)
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 206 -or $bytes.Length -ne 4 -or
      $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B -or $bytes[2] -ne 0x03 -or $bytes[3] -ne 0x04) {
      throw 'Published object did not return the expected ZIP range header.'
    }
  }
  finally {
    $client.Dispose()
  }
}

function Assert-RemoteMetadata {
  param([string]$Uri, $Identity)
  $remote = Invoke-RestMethod -Uri $Uri -TimeoutSec 30
  $remoteFileName = if ($remote.file_name) { [string]$remote.file_name } else { [string]$remote.fileName }
  if ([string]$remote.version -ne $Identity.version -or
    $remoteFileName -ne $Identity.fileName -or
    [int64]$remote.size -ne [int64]$Identity.size -or
    [string]$remote.sha512 -cne [string]$Identity.sha512 -or
    [string]$remote.buildId -ne [string]$Identity.buildId -or
    [string]$remote.gitCommit -ne [string]$Identity.commit) {
    throw 'Published metadata does not match the exact candidate.'
  }
}

function Initialize-SshAskpass {
  param([string]$CredentialPath, [string]$Directory)
  if ($CredentialPath.Contains("'")) {
    throw 'SSH credential path cannot contain a single quote.'
  }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $askpassPs1 = Join-Path $Directory 'askpass.ps1'
  $askpassCmd = Join-Path $Directory 'askpass.cmd'
  @"
`$ErrorActionPreference = 'Stop'
`$credential = Get-Content -Raw -LiteralPath '$CredentialPath' | ConvertFrom-Json
`$securePassword = ConvertTo-SecureString ([string]`$credential.passwordDpapi)
`$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$securePassword)
try {
  `$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$pointer)
  [Console]::Out.WriteLine(`$password)
} finally {
  `$password = `$null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$pointer)
}
"@ | Set-Content -LiteralPath $askpassPs1 -Encoding ASCII
  @"
@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$askpassPs1"
"@ | Set-Content -LiteralPath $askpassCmd -Encoding ASCII
  return $askpassCmd
}

function Invoke-ProductionSsh {
  param(
    [Parameter(Mandatory = $true)][string]$RemoteCommand,
    [AllowNull()][string]$InputText = $null
  )
  $sshPath = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
  $target = "$($script:SshMetadata.user)@$($script:SshMetadata.host)"
  $arguments = @(
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=20',
    $target,
    $RemoteCommand
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $sshPath
  $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.EnvironmentVariables['SSH_ASKPASS'] = $script:AskpassPath
  $startInfo.EnvironmentVariables['SSH_ASKPASS_REQUIRE'] = 'force'
  $startInfo.EnvironmentVariables['DISPLAY'] = 'uclaw-release'

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Failed to start production SSH.' }
  if ($null -ne $InputText) { $process.StandardInput.Write($InputText) }
  $process.StandardInput.Close()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) {
    throw "Production SSH command failed with exit code $exitCode. $stderr"
  }
  return [pscustomobject]@{ Stdout = $stdout; Stderr = $stderr }
}

function Get-PostgresContainer {
  $result = Invoke-ProductionSsh -RemoteCommand 'kubectl get pods -A -o json'
  $document = $result.Stdout | ConvertFrom-Json
  $candidates = @(
    foreach ($item in $document.items) {
      if ($item.status.phase -ne 'Running') { continue }
      foreach ($container in $item.spec.containers) {
        if ([string]$container.image -match '(^|/)postgres(?:ql)?([:@]|$)') {
          [pscustomobject]@{
            Namespace = [string]$item.metadata.namespace
            Pod = [string]$item.metadata.name
            Container = [string]$container.name
            Image = [string]$container.image
          }
        }
      }
    }
  )
  if ($candidates.Count -ne 1) {
    throw "Expected exactly one running PostgreSQL container, found $($candidates.Count)."
  }
  return $candidates[0]
}

function Invoke-ProductionPsql {
  param($Container, [string]$Sql)
  $database = [string]$script:SshMetadata.database
  if ($database -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid production database metadata.' }
  foreach ($name in @($Container.Namespace, $Container.Pod, $Container.Container)) {
    if ([string]$name -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid Kubernetes container metadata.' }
  }
  $command = "kubectl exec -i -n $($Container.Namespace) $($Container.Pod) -c $($Container.Container) -- psql -X -qAt -v ON_ERROR_STOP=1 -U root -d $database"
  return Invoke-ProductionSsh -RemoteCommand $command -InputText $Sql
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be a stable semantic version.' }
if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'Commit must be a full Git SHA.' }
if ($ReleaseNotes.Length -gt 10000) { throw 'Release notes exceed 10000 characters.' }

$candidateDir = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$candidate = Get-Content -Raw -LiteralPath (Join-Path $candidateDir 'candidate.json') | ConvertFrom-Json
$candidateMetadataFileName = [string]$candidate.metadataFileName
$candidateZipFileName = [string]$candidate.zipFileName
if (-not $candidateMetadataFileName -or [IO.Path]::GetFileName($candidateMetadataFileName) -ne $candidateMetadataFileName) {
  throw 'Candidate metadataFileName must be a plain file name.'
}
if (-not $candidateZipFileName -or [IO.Path]::GetFileName($candidateZipFileName) -ne $candidateZipFileName) {
  throw 'Candidate zipFileName must be a plain file name.'
}
$metadataPath = Join-Path $candidateDir $candidateMetadataFileName
$zipPath = Join-Path $candidateDir $candidateZipFileName
$metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
$zip = Get-Item -LiteralPath $zipPath
$digest = (Get-FileHash -Algorithm SHA512 -LiteralPath $zipPath).Hash.ToLowerInvariant()
$metadataFileName = if ($metadata.file_name) { [string]$metadata.file_name } else { [string]$metadata.fileName }

if ($candidate.version -ne $Version -or $candidate.commit -ne $Commit) { throw 'Candidate identity does not match the requested release.' }
if ($metadata.version -ne $Version -or $metadata.gitCommit -ne $Commit) { throw 'Portable metadata identity mismatch.' }
if (-not $metadata.buildId -or $candidate.buildId -ne $metadata.buildId) { throw 'Portable build ID mismatch.' }
if ($metadataFileName -ne $zip.Name -or $zip.Name -ne "UClaw-$Version-win-x64-usb.zip") { throw 'Portable filename mismatch.' }
if ([int64]$metadata.size -ne $zip.Length -or [int64]$candidate.size -ne $zip.Length) { throw 'Portable size mismatch.' }
if ([string]$metadata.sha512 -cne $digest -or [string]$candidate.sha512 -cne $digest) { throw 'Portable SHA-512 mismatch.' }

$identity = [pscustomobject]@{
  version = $Version
  commit = $Commit
  buildId = [string]$metadata.buildId
  fileName = $zip.Name
  size = [int64]$zip.Length
  sha512 = $digest
}

if ($ValidateOnly) {
  [pscustomobject]@{
    status = 'VALIDATION_OK'
    version = $identity.version
    commit = $identity.commit
    buildId = $identity.buildId
    fileName = $identity.fileName
    size = $identity.size
    sha512 = $identity.sha512
  } | ConvertTo-Json -Depth 4
  return
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..')).Path
$resolvedOssCredentialPath = (Resolve-Path -LiteralPath $OssCredentialPath).Path
$resolvedSshCredentialPath = (Resolve-Path -LiteralPath $SshCredentialPath).Path
if (Test-PathInside $resolvedOssCredentialPath $repoRoot) { throw 'OSS credentials must be stored outside the Git repository.' }
if (Test-PathInside $resolvedSshCredentialPath $repoRoot) { throw 'SSH credentials must be stored outside the Git repository.' }
if (-not (Test-Path -LiteralPath $OssutilPath -PathType Leaf)) { throw "ossutil not found: $OssutilPath" }

$ossCredential = Get-Content -Raw -LiteralPath $resolvedOssCredentialPath | ConvertFrom-Json
$script:SshMetadata = Get-Content -Raw -LiteralPath $resolvedSshCredentialPath | ConvertFrom-Json
if ($ossCredential.bucket -ne 'uclaw-ver' -or $ossCredential.region -ne 'cn-beijing' -or $ossCredential.prefix -ne 'releases/latest/') {
  throw 'OSS credential metadata does not target the approved UClaw release location.'
}
if ([int]$script:SshMetadata.schemaVersion -ne 1 -or -not $script:SshMetadata.passwordDpapi) { throw 'Invalid production SSH credential metadata.' }

$zipUrl = "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$($zip.Name)"
$jsonName = [IO.Path]::GetFileName($metadataPath)
$jsonUrl = "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$jsonName"
$currentRelease = Get-PublicRelease -RequireResponse
if ($currentRelease -and [version]$currentRelease.version -gt [version]$Version) {
  throw "Refusing to replace newer production version $($currentRelease.version) with $Version."
}
if ($currentRelease -and [string]$currentRelease.version -eq $Version -and -not (Test-ReleaseMatches $currentRelease $identity $zipUrl)) {
  throw 'Production already contains this version with different immutable metadata.'
}
$alreadyPublished = Test-ReleaseMatches $currentRelease $identity $zipUrl

$temporaryConfig = Join-Path $env:TEMP ('uclaw-oss-' + [guid]::NewGuid().ToString('N') + '.ini')
$askpassDirectory = Join-Path $env:TEMP ('uclaw-ssh-askpass-' + [guid]::NewGuid().ToString('N'))
$secretPointer = [IntPtr]::Zero
$secret = $null
$databaseChanged = $false
$previousRows = @()
$releaseRow = $null
try {
  $zipHead = Get-HttpHead $zipUrl
  $jsonHead = Get-HttpHead $jsonUrl
  if ($zipHead.Exists -and $zipHead.Length -ne $identity.size) {
    throw 'The immutable OSS ZIP name already exists with a different size.'
  }
  if ($zipHead.Exists) {
    Assert-RemoteZip $zipUrl $identity.size
  }
  if ($jsonHead.Exists) {
    Assert-RemoteMetadata $jsonUrl $identity
  }

  $needsZipUpload = -not $zipHead.Exists
  $needsJsonUpload = -not $jsonHead.Exists
  if ($needsZipUpload -or $needsJsonUpload) {
    $secureSecret = ConvertTo-SecureString ([string]$ossCredential.accessKeySecretDpapi)
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    @"
[default]
accessKeyID=$($ossCredential.accessKeyId)
accessKeySecret=$secret
region=$($ossCredential.region)
"@ | Set-Content -LiteralPath $temporaryConfig -Encoding ASCII

    if ($needsZipUpload) {
      & $OssutilPath cp $zipPath "oss://$($ossCredential.bucket)/$($ossCredential.prefix)$($zip.Name)" --config-file $temporaryConfig --update
      if ($LASTEXITCODE -ne 0) { throw "OSS ZIP upload failed with exit code $LASTEXITCODE." }
    }
    if ($needsJsonUpload) {
      & $OssutilPath cp $metadataPath "oss://$($ossCredential.bucket)/$($ossCredential.prefix)$jsonName" --config-file $temporaryConfig --update
      if ($LASTEXITCODE -ne 0) { throw "OSS JSON upload failed with exit code $LASTEXITCODE." }
    }
  }
  Assert-RemoteZip $zipUrl $identity.size
  Assert-RemoteMetadata $jsonUrl $identity

  if (-not $alreadyPublished) {
    $script:AskpassPath = Initialize-SshAskpass -CredentialPath $resolvedSshCredentialPath -Directory $askpassDirectory
    $postgres = Get-PostgresContainer
    $priorSql = @'
\set ON_ERROR_STOP on
SELECT coalesce(json_agg(json_build_object('id', id, 'version', version) ORDER BY id), '[]'::json)::text
FROM claw_x_releases
WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
  AND package_type = 'portable_zip' AND enabled = true;
'@
    $priorResult = Invoke-ProductionPsql -Container $postgres -Sql $priorSql
    $priorLine = @($priorResult.Stdout -split "`r?`n" | Where-Object { $_.Trim().StartsWith('[') })[-1]
    if ($priorLine) { $previousRows = @($priorLine | ConvertFrom-Json) }

    $mandatorySql = if ($Mandatory) { 'true' } else { 'false' }
    $notes = if ($ReleaseNotes) { $ReleaseNotes } else { "UClaw $Version production release." }
    $releaseDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
    $sql = @"
\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE claw_x_releases IN SHARE ROW EXCLUSIVE MODE;

DO `$uclaw`$
BEGIN
  IF EXISTS (
    SELECT 1 FROM claw_x_releases
    WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
      AND package_type = 'portable_zip' AND enabled = true
      AND version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
      AND string_to_array(version, '.')::integer[] > string_to_array($(ConvertTo-SqlLiteral $Version), '.')::integer[]
  ) THEN
    RAISE EXCEPTION 'refusing to replace a newer enabled Windows portable release';
  END IF;

  IF EXISTS (
    SELECT 1 FROM claw_x_releases
    WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
      AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version)
      AND (
        file_name IS DISTINCT FROM $(ConvertTo-SqlLiteral $identity.fileName)
        OR file_url IS DISTINCT FROM $(ConvertTo-SqlLiteral $zipUrl)
        OR sha512 IS DISTINCT FROM $(ConvertTo-SqlLiteral $identity.sha512)
        OR size IS DISTINCT FROM $($identity.size)
      )
  ) THEN
    RAISE EXCEPTION 'this release version already exists with different immutable metadata';
  END IF;

  IF (
    SELECT count(*) FROM claw_x_releases
    WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
      AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version)
  ) > 1 THEN
    RAISE EXCEPTION 'this release version has duplicate database rows';
  END IF;
END;
`$uclaw`$;

UPDATE claw_x_releases
SET enabled = false, updated_at = extract(epoch from now())::bigint
WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
  AND package_type = 'portable_zip' AND version <> $(ConvertTo-SqlLiteral $Version);

INSERT INTO claw_x_releases (
  channel, platform, arch, package_type, version, file_name, file_url,
  sha512, size, release_date, release_notes, enabled, mandatory, created_at, updated_at
)
SELECT 'latest', 'win', 'x64', 'portable_zip',
  $(ConvertTo-SqlLiteral $Version), $(ConvertTo-SqlLiteral $identity.fileName), $(ConvertTo-SqlLiteral $zipUrl),
  $(ConvertTo-SqlLiteral $identity.sha512), $($identity.size), $(ConvertTo-SqlLiteral $releaseDate),
  $(ConvertTo-SqlLiteral $notes), true, $mandatorySql,
  extract(epoch from now())::bigint, extract(epoch from now())::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM claw_x_releases
  WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
    AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version)
);

UPDATE claw_x_releases
SET file_name = $(ConvertTo-SqlLiteral $identity.fileName),
    file_url = $(ConvertTo-SqlLiteral $zipUrl),
    sha512 = $(ConvertTo-SqlLiteral $identity.sha512),
    size = $($identity.size),
    release_date = $(ConvertTo-SqlLiteral $releaseDate),
    release_notes = $(ConvertTo-SqlLiteral $notes),
    enabled = true,
    mandatory = $mandatorySql,
    updated_at = extract(epoch from now())::bigint
WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
  AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version);

DO `$uclaw`$
DECLARE enabled_count integer;
BEGIN
  SELECT count(*) INTO enabled_count FROM claw_x_releases
  WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
    AND package_type = 'portable_zip' AND enabled = true;
  IF enabled_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one enabled Windows portable release, found %', enabled_count;
  END IF;
END;
`$uclaw`$;
COMMIT;

SELECT json_build_object(
  'id', id, 'version', version, 'file_name', file_name, 'file_url', file_url,
  'sha512', sha512, 'size', size, 'enabled', enabled,
  'mandatory', mandatory, 'release_date', release_date
)::text
FROM claw_x_releases
WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
  AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version)
ORDER BY id DESC LIMIT 1;
"@
    $updateResult = Invoke-ProductionPsql -Container $postgres -Sql $sql
    $databaseChanged = $true
    $rowLine = @($updateResult.Stdout -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]
    if ($rowLine) { $releaseRow = $rowLine | ConvertFrom-Json }
  }

  $verifiedRelease = $null
  for ($attempt = 1; $attempt -le 12; $attempt += 1) {
    $verifiedRelease = Get-PublicRelease
    if (Test-ReleaseMatches $verifiedRelease $identity $zipUrl) { break }
    if ($attempt -lt 12) { Start-Sleep -Seconds 5 }
  }
  if (-not (Test-ReleaseMatches $verifiedRelease $identity $zipUrl)) {
    if ($databaseChanged) {
      $ids = @($previousRows | ForEach-Object { [int64]$_.id }) -join ','
      $restoreSql = if ($ids -match '^\d+(,\d+)*$') {
        "UPDATE claw_x_releases SET enabled = true, updated_at = extract(epoch from now())::bigint WHERE id IN ($ids);"
      } else {
        ''
      }
      $rollbackSql = @"
\set ON_ERROR_STOP on
BEGIN;
UPDATE claw_x_releases SET enabled = false, updated_at = extract(epoch from now())::bigint
WHERE channel = 'latest' AND platform = 'win' AND arch = 'x64'
  AND package_type = 'portable_zip' AND version = $(ConvertTo-SqlLiteral $Version);
$restoreSql
COMMIT;
"@
      [void](Invoke-ProductionPsql -Container $postgres -Sql $rollbackSql)
    }
    throw 'Public release feed did not converge to the exact candidate; previous enabled rows were restored when possible.'
  }

  Assert-RemoteZip $zipUrl $identity.size
  Assert-RemoteMetadata $jsonUrl $identity
  $receipt = [ordered]@{
    schemaVersion = 1
    publishedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = 'published'
    alreadyPublished = $alreadyPublished
    version = $identity.version
    commit = $identity.commit
    buildId = $identity.buildId
    fileName = $identity.fileName
    url = $zipUrl
    metadataUrl = $jsonUrl
    size = $identity.size
    sha512 = $identity.sha512
    mandatory = $Mandatory
    releaseDate = [string]$verifiedRelease.release_date
    databaseRowId = if ($releaseRow) { $releaseRow.id } else { $null }
    publicFeed = $PublicFeedUri
  }
  $receiptPath = Join-Path $candidateDir 'publication.json'
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $receipt | ConvertTo-Json -Depth 5
}
finally {
  if (Test-Path -LiteralPath $temporaryConfig) {
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
  }
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  $secret = $null
  if (Test-Path -LiteralPath $askpassDirectory) {
    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedAskpass = [IO.Path]::GetFullPath($askpassDirectory).TrimEnd('\') + '\'
    if ($resolvedAskpass.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $askpassDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
