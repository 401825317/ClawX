# UClaw Windows USB 与 macOS 正式候选和本地暂存

正式候选使用 `.github/workflows/uclaw-portable-production.yml`。GitHub Actions 只在托管 Runner 上构建 Windows x64 与 macOS x64/arm64 USB ZIP，校验精确版本、commit、build ID、size 和 SHA-512，并上传不可变候选制品。

Actions 不持有生产凭证，不上传 OSS，不连接 zz-cn，不创建 Git 标签或 GitHub Release，也不依赖自托管 Runner。当前 USB 候选为未签名制品；本地暂存不会改变候选字节或补加签名。

生产 OSS/zz-cn 暂存必须在保存了 DPAPI 凭证的 Windows 机器上执行。所有新记录固定为 `enabled=false`，现有公共更新 Feed 必须保持不变；启用候选属于独立审批操作。

正式发包不执行源码 E2E、成品 Full、托管 Live、新用户注册、激活或重登回归。功能 QA 是独立任务，不属于候选构建或生产暂存。

## 发布顺序

1. 确认待发布代码位于负责人批准的发布分支远端最新提交，`package.json` 使用新的稳定版本号。
2. 从该分支手动运行 `UClaw Windows USB and macOS Production Candidates`，输入同一版本号。
3. 等待 Windows 与 macOS GitHub 托管 Runner 构建完成；最终 `Confirm immutable production candidates` 作业应为绿色。
4. 在本地下载该 run 的两个精确候选制品。
5. 先用 `-ValidateOnly` 校验候选身份，再运行本地发布脚本。
6. 发布器上传或复用 5 个不可变 OSS 对象，在一个数据库事务中登记 3 条 `enabled=false` 记录，并验证公共 Feed 前后完全一致。

## GitHub 配置

该工作流只需要标准 GitHub 托管 Runner 和仓库读取权限，不需要 Actions Secrets、Environment 或自托管 Runner。`workflow_dispatch` 必须从包含该工作流文件的分支触发。

工作流保留 14 天的两个 Actions 制品：

```text
uclaw-production-candidate-<version>-<short-commit>
uclaw-macos-production-candidate-<version>-<short-commit>
```

## 本地下载与暂存

在 `frontend-clawx` 的干净工作区中运行，`runId`、`version` 和 `commit` 必须来自同一次成功的 Actions run：

```powershell
$runId = '<github-run-id>'
$version = '<x.y.z>'
$commit = '<40-character-commit>'
$shortCommit = $commit.Substring(0, 7)
$stageRoot = Join-Path $env:TEMP "uclaw-production-$runId"
$windowsCandidate = Join-Path $stageRoot 'windows-candidate'
$macosCandidate = Join-Path $stageRoot 'macos-candidate'

New-Item -ItemType Directory -Force -Path $windowsCandidate, $macosCandidate | Out-Null
gh run download $runId -n "uclaw-production-candidate-$version-$shortCommit" -D $windowsCandidate
gh run download $runId -n "uclaw-macos-production-candidate-$version-$shortCommit" -D $macosCandidate

& scripts/windows-support/publish-disabled-release-stage.ps1 `
  -WindowsCandidateDirectory $windowsCandidate `
  -MacosCandidateDirectory $macosCandidate `
  -Version $version `
  -Commit $commit `
  -ValidateOnly

& scripts/windows-support/publish-disabled-release-stage.ps1 `
  -WindowsCandidateDirectory $windowsCandidate `
  -MacosCandidateDirectory $macosCandidate `
  -Version $version `
  -Commit $commit
```

成功后，Windows 候选目录会生成 `stage-publication.json`，其中记录 OSS URL、3 条数据库记录以及暂存前后的公共 Feed 快照。

## DPAPI 凭证

生产凭证只保存在执行本地暂存的同一 Windows 用户目录：

```text
%APPDATA%\UClaw\release-credentials\
  oss-release.json
  production-ssh.json
```

- `oss-release.json` 的 `accessKeySecretDpapi` 是 PowerShell `ConvertFrom-SecureString` 输出。
- `production-ssh.json` 的 `passwordDpapi` 是 PowerShell `ConvertFrom-SecureString` 输出。
- `ossutil.exe` 固定为 `%TEMP%\uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe`。
- DPAPI 文件必须由实际执行发布的同一机器、同一 Windows 用户创建。
- 凭证不得提交到 Git、写入 Actions 参数或环境变量，也不得进入日志、报告或制品。

## 暂存硬校验

- 输入版本必须是稳定语义版本，并与 Windows/macOS 两份候选的完整 commit 一致。
- Windows JSON、两个 macOS ZIP 和 macOS manifest 必须与本地候选字节一致。
- 已存在的同名 OSS 对象不可覆盖为不同 size 或 SHA-512；重跑只能复用完全相同的对象。
- ZIP 必须返回 HTTP 200、精确 `Content-Length`、`Accept-Ranges: bytes`、允许的 Content-Type 和 `PK` 文件头。
- 所有 5 个 OSS 对象都必须完成远端 SHA-512 回读；JSON HEAD 缺少 `Content-Length` 时仍以完整 SHA-512 和内容一致性为准。
- `claw_x_releases` 写入使用 `ON_ERROR_STOP` 事务，Windows x64、macOS x64 和 macOS arm64 必须恰好各有一条 `enabled=false` 记录。
- 暂存前后的所有既有启用记录和三个公共 Feed 必须完全一致。

## 独立回归

需要 QA 时单独执行：

```powershell
pnpm run test:e2e
pnpm run test:packaged:win:full
pnpm run test:packaged:win:live
```

详细隔离和凭证规则见 `PACKAGED_REGRESSION.md`。

## 故障处理

- Actions 构建失败：没有生产写入，修复后用新版本或明确处置同版本不可变制品。
- OSS 上传中断：公共 Feed 不变；重跑会验证并复用已存在的相同对象。
- 数据库事务失败：旧 release 保持原状态，修复连接或脚本后重跑。
- 公共 Feed 发生变化：新记录仍保持禁用，暂存失败并要求核对并发的版本操作。
- 不要用新 commit 重新构建已经上传的同版本文件名；候选 commit 或字节变化时必须使用新版本号。
