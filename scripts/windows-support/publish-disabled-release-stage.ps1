[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$WindowsCandidateDirectory,

  [Parameter(Mandatory = $true)]
  [string]$MacosCandidateDirectory,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [string]$ReleaseNotes = '',

  [bool]$Mandatory = $false,

  [string]$OssCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\oss-release.json'),

  [string]$SshCredentialPath = (Join-Path $env:APPDATA 'UClaw\release-credentials\production-ssh.json'),

  [string]$OssutilPath = (Join-Path $env:TEMP 'uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe'),

  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$script:AskpassPath = ''
$script:SshMetadata = $null

function ConvertTo-WindowsCommandLineArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $backslashes += 1; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-SqlLiteral {
  param([AllowEmptyString()][string]$Value)
  if ($null -eq $Value) { $Value = '' }
  return "'$($Value.Replace([string][char]0, '').Replace("'", "''"))'"
}

function Test-PathInside {
  param([string]$Child, [string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  return $childPath.StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha512Base64 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA512]::Create()
  try { return [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-Sha512Hex {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA512 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-RemoteSha512Hex {
  param([string]$Uri)
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(30)
  $algorithm = [Security.Cryptography.SHA512]::Create()
  try {
    $response = $client.GetAsync($Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Remote digest download failed with HTTP $([int]$response.StatusCode): $Uri" }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try {
      $digest = $algorithm.ComputeHash($stream)
      return ([BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
    }
    finally { $stream.Dispose(); $response.Dispose() }
  }
  finally { $algorithm.Dispose(); $client.Dispose(); $handler.Dispose() }
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
    $statusCode = if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($statusCode -eq 404) { return [pscustomobject]@{ Exists = $false; Status = 404; Length = 0 } }
    throw
  }
}

function Assert-RemoteZip {
  param([string]$Uri, [int64]$ExpectedSize)
  $head = Get-HttpHead $Uri
  if (-not $head.Exists -or $head.Status -ne 200 -or $head.Length -ne $ExpectedSize) { throw "Remote ZIP verification failed: $Uri" }
  if ($head.AcceptRanges -ne 'bytes') { throw "Remote ZIP does not advertise byte ranges: $Uri" }
  if (@('application/zip', 'application/x-zip-compressed', 'application/octet-stream') -notcontains $head.ContentType) {
    throw "Remote ZIP content type is not allowed: $($head.ContentType)"
  }
  Add-Type -AssemblyName System.Net.Http
  $client = [Net.Http.HttpClient]::new()
  try {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
    $request.Headers.Range = [Net.Http.Headers.RangeHeaderValue]::new(0, 3)
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 206 -or $bytes.Length -ne 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
      throw "Remote object is not a range-readable ZIP: $Uri"
    }
  }
  finally { $client.Dispose() }
}

function Get-PublicFeedIdentity {
  param([string]$Platform, [string]$Arch, [string]$PackageType)
  $cacheBust = [guid]::NewGuid().ToString('N')
  $uri = "https://zz-cn.lingzhiwuxian.com/api/clawx/updates/latest?channel=latest&platform=$Platform&arch=$Arch&package_type=$PackageType&_stage_check=$cacheBust"
  $response = Invoke-RestMethod -Uri $uri -Headers @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' } -TimeoutSec 30
  if ($response.success -ne $true) { throw "Public release feed failed for $Platform/$Arch/$PackageType." }
  $data = $response.data
  $resolvedPackageType = if ($data.package_type) { [string]$data.package_type } else { [string]$data.packageType }
  $resolvedDownloadUrl = if ($data.download_url) { [string]$data.download_url } else { [string]$data.downloadUrl }
  $resolvedFileName = if ($data.file_name) { [string]$data.file_name } else { [string]$data.fileName }
  $resolvedSize = if ($data.size) { [int64]$data.size } else { [int64]0 }
  $resolvedReleaseDate = if ($data.release_date) { [string]$data.release_date } else { [string]$data.releaseDate }
  $resolvedReleaseNotes = if ($data.release_notes) { [string]$data.release_notes } else { [string]$data.releaseNotes }
  return [ordered]@{
    platform = [string]$data.platform
    arch = [string]$data.arch
    packageType = $resolvedPackageType
    version = [string]$data.version
    downloadUrl = $resolvedDownloadUrl
    fileName = $resolvedFileName
    sha512 = [string]$data.sha512
    size = $resolvedSize
    mandatory = [bool]$data.mandatory
    releaseDate = $resolvedReleaseDate
    releaseNotes = $resolvedReleaseNotes
  }
}

function Initialize-SshAskpass {
  param([string]$CredentialPath, [string]$Directory)
  if ($CredentialPath.Contains("'")) { throw 'SSH credential path cannot contain a single quote.' }
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
  param([Parameter(Mandatory = $true)][string]$RemoteCommand, [AllowNull()][string]$InputText = $null)
  $sshPath = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
  $target = "$($script:SshMetadata.user)@$($script:SshMetadata.host)"
  $arguments = @(
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=password',
    '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=20',
    $target, $RemoteCommand
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
  if ($exitCode -ne 0) { throw "Production SSH command failed with exit code $exitCode. $stderr" }
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
          [pscustomobject]@{ Namespace = [string]$item.metadata.namespace; Pod = [string]$item.metadata.name; Container = [string]$container.name }
        }
      }
    }
  )
  if ($candidates.Count -ne 1) { throw "Expected exactly one running PostgreSQL container, found $($candidates.Count)." }
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

$windowsDir = (Resolve-Path -LiteralPath $WindowsCandidateDirectory).Path
$macosDir = (Resolve-Path -LiteralPath $MacosCandidateDirectory).Path
$windowsCandidate = Get-Content -Raw -LiteralPath (Join-Path $windowsDir 'candidate.json') | ConvertFrom-Json
$macosCandidate = Get-Content -Raw -LiteralPath (Join-Path $macosDir 'candidate.json') | ConvertFrom-Json
if ($windowsCandidate.version -ne $Version -or $windowsCandidate.commit -ne $Commit) { throw 'Windows candidate identity mismatch.' }
if ($macosCandidate.version -ne $Version -or $macosCandidate.commit -ne $Commit) { throw 'macOS candidate identity mismatch.' }
if (@($macosCandidate.artifacts).Count -ne 2) { throw 'macOS candidate must contain x64 and arm64 artifacts.' }

$windowsZipName = "UClaw-$Version-win-x64-usb.zip"
$windowsMetadataName = "UClaw-$Version-win-x64-usb.json"
$windowsZipPath = Join-Path $windowsDir $windowsZipName
$windowsMetadataPath = Join-Path $windowsDir $windowsMetadataName
$windowsZip = Get-Item -LiteralPath $windowsZipPath
$windowsMetadata = Get-Content -Raw -LiteralPath $windowsMetadataPath | ConvertFrom-Json
$windowsSha = (Get-FileHash -Algorithm SHA512 -LiteralPath $windowsZipPath).Hash.ToLowerInvariant()
if ($windowsCandidate.zipFileName -ne $windowsZipName -or $windowsCandidate.metadataFileName -ne $windowsMetadataName -or
  [int64]$windowsCandidate.size -ne $windowsZip.Length -or [string]$windowsCandidate.sha512 -cne $windowsSha -or
  [string]$windowsMetadata.sha512 -cne $windowsSha -or [int64]$windowsMetadata.size -ne $windowsZip.Length) {
  throw 'Windows candidate bytes do not match its immutable metadata.'
}

$objects = @(
  [pscustomobject]@{ LocalPath = $windowsZipPath; FileName = $windowsZipName; Size = [int64]$windowsZip.Length; Sha512Hex = $windowsSha },
  [pscustomobject]@{ LocalPath = $windowsMetadataPath; FileName = $windowsMetadataName; Size = [int64](Get-Item $windowsMetadataPath).Length; Sha512Hex = (Get-Sha512Hex $windowsMetadataPath) }
)
$releaseRows = @(
  [pscustomobject]@{ Platform = 'win'; Arch = 'x64'; PackageType = 'portable_zip'; FileName = $windowsZipName; Sha512 = $windowsSha; Size = [int64]$windowsZip.Length; ReleaseDate = [string]$windowsMetadata.releaseDate }
)

$seenMacArchitectures = @{}
foreach ($artifact in @($macosCandidate.artifacts)) {
  $arch = [string]$artifact.arch
  if (@('x64', 'arm64') -notcontains $arch -or $seenMacArchitectures.ContainsKey($arch)) { throw 'macOS candidate architectures are invalid or duplicated.' }
  $seenMacArchitectures[$arch] = $true
  $zipName = "UClaw-$Version-mac-$arch.zip"
  $blockmapName = "$zipName.blockmap"
  $dmgName = "UClaw-$Version-mac-$arch.dmg"
  if ([string]$artifact.updateFileName -ne $zipName -or [string]$artifact.updateBlockmapFileName -ne $blockmapName -or [string]$artifact.downloadFileName -ne $dmgName) { throw "macOS $arch filename mismatch." }
  $zipPath = Join-Path $macosDir $zipName
  $blockmapPath = Join-Path $macosDir $blockmapName
  $dmgPath = Join-Path $macosDir $dmgName
  $zip = Get-Item -LiteralPath $zipPath
  $blockmap = Get-Item -LiteralPath $blockmapPath
  $dmg = Get-Item -LiteralPath $dmgPath
  if ([int64]$artifact.updateSize -ne $zip.Length -or [string]$artifact.updateSha512 -cne (Get-Sha512Base64 $zipPath)) { throw "macOS $arch ZIP integrity mismatch." }
  if ([int64]$artifact.updateBlockmapSize -ne $blockmap.Length -or [string]$artifact.updateBlockmapSha512 -cne (Get-Sha512Base64 $blockmapPath)) { throw "macOS $arch blockmap integrity mismatch." }
  if ([int64]$artifact.downloadSize -ne $dmg.Length -or [string]$artifact.downloadSha512 -cne (Get-Sha512Base64 $dmgPath)) { throw "macOS $arch DMG integrity mismatch." }
  $objects += [pscustomobject]@{ LocalPath = $zipPath; FileName = $zipName; Size = [int64]$zip.Length; Sha512Hex = (Get-Sha512Hex $zipPath) }
  $objects += [pscustomobject]@{ LocalPath = $blockmapPath; FileName = $blockmapName; Size = [int64]$blockmap.Length; Sha512Hex = (Get-Sha512Hex $blockmapPath) }
  $objects += [pscustomobject]@{ LocalPath = $dmgPath; FileName = $dmgName; Size = [int64]$dmg.Length; Sha512Hex = (Get-Sha512Hex $dmgPath) }
  $releaseRows += [pscustomobject]@{ Platform = 'mac'; Arch = $arch; PackageType = 'installer'; FileName = $zipName; Sha512 = [string]$artifact.updateSha512; Size = [int64]$artifact.updateSize; ReleaseDate = [string]$macosCandidate.releaseDate }
}
if ($seenMacArchitectures.Count -ne 2) { throw 'macOS candidate must contain x64 and arm64 exactly once.' }

$macosManifestName = "UClaw-$Version-mac.json"
$macosManifestPath = Join-Path $macosDir 'candidate.json'
$objects += [pscustomobject]@{ LocalPath = $macosManifestPath; FileName = $macosManifestName; Size = [int64](Get-Item $macosManifestPath).Length; Sha512Hex = (Get-Sha512Hex $macosManifestPath) }

if ($ValidateOnly) {
  [pscustomobject]@{ status = 'VALIDATION_OK'; mode = 'stage_disabled'; version = $Version; commit = $Commit; objects = $objects.Count; releases = $releaseRows.Count } | ConvertTo-Json -Depth 4
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
if ($ossCredential.bucket -ne 'uclaw-ver' -or $ossCredential.region -ne 'cn-beijing' -or $ossCredential.prefix -ne 'releases/latest/') { throw 'OSS credential metadata does not target the approved UClaw release location.' }
if ([int]$script:SshMetadata.schemaVersion -ne 1 -or -not $script:SshMetadata.passwordDpapi) { throw 'Invalid production SSH credential metadata.' }

$feedBefore = @(
  Get-PublicFeedIdentity -Platform 'win' -Arch 'x64' -PackageType 'portable_zip'
  Get-PublicFeedIdentity -Platform 'mac' -Arch 'x64' -PackageType 'installer'
  Get-PublicFeedIdentity -Platform 'mac' -Arch 'arm64' -PackageType 'installer'
) | ConvertTo-Json -Depth 5 -Compress
$temporaryConfig = Join-Path $env:TEMP ('uclaw-oss-' + [guid]::NewGuid().ToString('N') + '.ini')
$askpassDirectory = Join-Path $env:TEMP ('uclaw-ssh-askpass-' + [guid]::NewGuid().ToString('N'))
$secretPointer = [IntPtr]::Zero
$secret = $null
try {
  $pending = @()
  foreach ($object in $objects) {
    $uri = "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$($object.FileName)"
    $head = Get-HttpHead $uri
    if ($head.Exists -and $head.Length -ne $object.Size) { throw "Immutable OSS object already exists with a different size: $($object.FileName)" }
    if (-not $head.Exists) { $pending += $object }
  }
  if ($pending.Count -gt 0) {
    $secureSecret = ConvertTo-SecureString ([string]$ossCredential.accessKeySecretDpapi)
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    @"
[default]
accessKeyID=$($ossCredential.accessKeyId)
accessKeySecret=$secret
region=$($ossCredential.region)
"@ | Set-Content -LiteralPath $temporaryConfig -Encoding ASCII
    foreach ($object in $pending) {
      & $OssutilPath cp $object.LocalPath "oss://$($ossCredential.bucket)/$($ossCredential.prefix)$($object.FileName)" --config-file $temporaryConfig --update
      if ($LASTEXITCODE -ne 0) { throw "OSS upload failed for $($object.FileName) with exit code $LASTEXITCODE." }
    }
  }
  foreach ($object in $objects) {
    $uri = "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$($object.FileName)"
    $head = Get-HttpHead $uri
    if (-not $head.Exists -or $head.Status -ne 200 -or $head.Length -ne $object.Size) { throw "OSS verification failed for $($object.FileName)." }
    if ($object.FileName.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) { Assert-RemoteZip $uri $object.Size }
    $remoteSha512 = Get-RemoteSha512Hex $uri
    if ($remoteSha512 -cne $object.Sha512Hex) { throw "OSS SHA-512 mismatch for $($object.FileName)." }
  }
  $remoteWindowsMetadata = Invoke-RestMethod -Uri "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$windowsMetadataName" -TimeoutSec 30
  if ([string]$remoteWindowsMetadata.version -ne $Version -or [string]$remoteWindowsMetadata.gitCommit -ne $Commit -or
    [string]$remoteWindowsMetadata.sha512 -cne $windowsSha -or [int64]$remoteWindowsMetadata.size -ne $windowsZip.Length) {
    throw 'Remote Windows metadata does not match the exact candidate.'
  }
  $remoteMacosMetadata = Invoke-RestMethod -Uri "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$macosManifestName" -TimeoutSec 30
  if ([string]$remoteMacosMetadata.version -ne $Version -or [string]$remoteMacosMetadata.commit -ne $Commit -or @($remoteMacosMetadata.artifacts).Count -ne 2) {
    throw 'Remote macOS metadata does not match the exact candidate.'
  }

  $script:AskpassPath = Initialize-SshAskpass -CredentialPath $resolvedSshCredentialPath -Directory $askpassDirectory
  $postgres = Get-PostgresContainer
  $notes = if ($ReleaseNotes) { $ReleaseNotes } else { "UClaw $Version staged pending activation." }
  $mandatorySql = if ($Mandatory) { 'true' } else { 'false' }
  $prechecks = ''
  $writes = ''
  foreach ($row in $releaseRows) {
    $platform = ConvertTo-SqlLiteral $row.Platform
    $arch = ConvertTo-SqlLiteral $row.Arch
    $packageType = ConvertTo-SqlLiteral $row.PackageType
    $versionLiteral = ConvertTo-SqlLiteral $Version
    $fileName = ConvertTo-SqlLiteral $row.FileName
    $fileUrl = ConvertTo-SqlLiteral "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$($row.FileName)"
    $sha512 = ConvertTo-SqlLiteral $row.Sha512
    $releaseDate = ConvertTo-SqlLiteral $row.ReleaseDate
    $releaseNotes = ConvertTo-SqlLiteral $notes
    $prechecks += @"
  IF (SELECT count(*) FROM claw_x_releases WHERE channel='latest' AND platform=$platform AND arch=$arch AND package_type=$packageType AND version=$versionLiteral) > 1 THEN
    RAISE EXCEPTION 'duplicate staged release row for %/%', $platform, $arch;
  END IF;
  IF EXISTS (SELECT 1 FROM claw_x_releases WHERE channel='latest' AND platform=$platform AND arch=$arch AND package_type=$packageType AND version=$versionLiteral AND enabled=true) THEN
    RAISE EXCEPTION 'refusing to stage a release version that is already enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM claw_x_releases WHERE channel='latest' AND platform=$platform AND arch=$arch AND package_type=$packageType AND version=$versionLiteral
      AND (file_name IS DISTINCT FROM $fileName OR file_url IS DISTINCT FROM $fileUrl OR sha512 IS DISTINCT FROM $sha512 OR size IS DISTINCT FROM $($row.Size) OR release_date IS DISTINCT FROM $releaseDate)
  ) THEN
    RAISE EXCEPTION 'staged release immutable metadata mismatch';
  END IF;
"@
    $writes += @"
INSERT INTO claw_x_releases (channel, platform, arch, package_type, version, file_name, file_url, sha512, size, release_date, release_notes, enabled, mandatory, created_at, updated_at)
SELECT 'latest', $platform, $arch, $packageType, $versionLiteral, $fileName, $fileUrl, $sha512, $($row.Size), $releaseDate, $releaseNotes, false, $mandatorySql,
  extract(epoch from now())::bigint, extract(epoch from now())::bigint
WHERE NOT EXISTS (SELECT 1 FROM claw_x_releases WHERE channel='latest' AND platform=$platform AND arch=$arch AND package_type=$packageType AND version=$versionLiteral);
UPDATE claw_x_releases SET release_notes=$releaseNotes, mandatory=$mandatorySql, updated_at=extract(epoch from now())::bigint
WHERE channel='latest' AND platform=$platform AND arch=$arch AND package_type=$packageType AND version=$versionLiteral AND enabled=false;
"@
  }
  $sql = @"
\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE claw_x_releases IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE uclaw_enabled_before ON COMMIT DROP AS
SELECT id, channel, platform, arch, package_type, version FROM claw_x_releases
WHERE enabled=true;
DO `$uclaw`$
BEGIN
$prechecks
END;
`$uclaw`$;
$writes
DO `$uclaw`$
BEGIN
  IF EXISTS (
    (SELECT id, channel, platform, arch, package_type, version FROM uclaw_enabled_before EXCEPT SELECT id, channel, platform, arch, package_type, version FROM claw_x_releases WHERE enabled=true)
    UNION ALL
    (SELECT id, channel, platform, arch, package_type, version FROM claw_x_releases WHERE enabled=true EXCEPT SELECT id, channel, platform, arch, package_type, version FROM uclaw_enabled_before)
  ) THEN
    RAISE EXCEPTION 'stage operation changed an enabled release';
  END IF;
  IF (SELECT count(*) FROM claw_x_releases WHERE channel='latest' AND version=$(ConvertTo-SqlLiteral $Version) AND enabled=false AND ((platform='win' AND arch='x64' AND package_type='portable_zip') OR (platform='mac' AND arch IN ('x64','arm64') AND package_type='installer'))) <> 3 THEN
    RAISE EXCEPTION 'expected exactly three disabled stage rows for version %', $(ConvertTo-SqlLiteral $Version);
  END IF;
END;
`$uclaw`$;
COMMIT;
SELECT coalesce(json_agg(json_build_object('id',id,'platform',platform,'arch',arch,'package_type',package_type,'version',version,'enabled',enabled,'file_url',file_url,'sha512',sha512,'size',size) ORDER BY platform,arch), '[]'::json)::text
FROM claw_x_releases WHERE channel='latest' AND version=$(ConvertTo-SqlLiteral $Version) AND ((platform='win' AND arch='x64' AND package_type='portable_zip') OR (platform='mac' AND arch IN ('x64','arm64') AND package_type='installer'));
"@
  $databaseResult = Invoke-ProductionPsql -Container $postgres -Sql $sql
  $rowsLine = @($databaseResult.Stdout -split "`r?`n" | Where-Object { $_.Trim().StartsWith('[') })[-1]
  if (-not $rowsLine) { throw 'Production database did not return staged release evidence.' }
  $databaseRows = @($rowsLine | ConvertFrom-Json)

  $feedAfter = @(
    Get-PublicFeedIdentity -Platform 'win' -Arch 'x64' -PackageType 'portable_zip'
    Get-PublicFeedIdentity -Platform 'mac' -Arch 'x64' -PackageType 'installer'
    Get-PublicFeedIdentity -Platform 'mac' -Arch 'arm64' -PackageType 'installer'
  ) | ConvertTo-Json -Depth 5 -Compress
  if ($feedAfter -cne $feedBefore -or $feedAfter -match ('"version":"' + [regex]::Escape($Version) + '"')) {
    throw 'Public release feed changed during disabled staging.'
  }

  $receipt = [ordered]@{
    schemaVersion = 1
    status = 'staged_disabled'
    stagedAt = (Get-Date).ToUniversalTime().ToString('o')
    version = $Version
    commit = $Commit
    enabled = $false
    mandatory = $Mandatory
    uploadedObjects = @($objects | ForEach-Object { "https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest/$($_.FileName)" })
    databaseRows = $databaseRows
    publicFeedBefore = $feedBefore | ConvertFrom-Json
    publicFeedAfter = $feedAfter | ConvertFrom-Json
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $windowsDir 'stage-publication.json') -Encoding UTF8
  $receipt | ConvertTo-Json -Depth 8
}
finally {
  if (Test-Path -LiteralPath $temporaryConfig) { Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue }
  if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
  $secret = $null
  if (Test-Path -LiteralPath $askpassDirectory) {
    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedAskpass = [IO.Path]::GetFullPath($askpassDirectory).TrimEnd('\') + '\'
    if ($resolvedAskpass.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $askpassDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
