# UClaw Windows 便携正式发布

正式 Windows USB ZIP 使用 `.github/workflows/uclaw-portable-production.yml`。该工作流覆盖候选构建、签名后 Full、全新账号注册 Live、OSS、生产更新记录、Git 标签和 GitHub Release。

旧的 `release.yml` 仍用于通用多平台 Electron 发布，但不能替代 UClaw Windows 便携版的生产 feed 流程。

## 发布顺序

1. 所有改动先在 `develop` 生成内测包并完成验收。
2. 将验收通过的改动提升到 `master`，并把 `package.json` 改成新的稳定版本号。
3. 等待远端 `master` 完全同步，不要提前创建版本标签。
4. 从 GitHub Actions 手动运行 `UClaw Windows Portable Production`，选择 `master` 并输入与 `package.json` 相同的版本号。
5. GitHub 托管 Windows Runner 完成源码检查、构建、SignPath 深度签名以及签名后精确 ZIP 的 Full 回归。
6. 审批 `uclaw-production` Environment。
7. 自托管 Runner 通过最终 ZIP 注册全新临时账号，完成退出重登和真实 Responses、图片、视频 Live。
8. 上述测试命令成功后，工作流上传 OSS、事务更新 `claw_x_releases`、公网回读、创建 annotated tag 和 GitHub Release。

工作流没有跳过测试或强制发布输入。任何必需命令失败都会发生在 OSS/feed 写入之前。

## GitHub 配置

仓库需要：

- 将 GitHub 仓库 Default branch 设为 `master`；`workflow_dispatch` 只会从默认分支注册工作流，源码预检仍会拒绝任何非 `master` 触发。
- Secret `SIGNPATH_API_TOKEN`。
- Variable `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG`，必须指向能深度签名 ZIP 内 `UClaw.exe` 和便携更新器的 SignPath artifact configuration。
- Environment `uclaw-production`。
- Environment 设置 required reviewers、禁止 self-review，并将 deployment branch 限定为 `master`。
- 一台带 `self-hosted`、`Windows`、`X64`、`uclaw-release` 标签的 Windows Runner。

生产 Runner 必须：

- 使用固定专用 Windows 用户运行，不能与个人开发会话混用。
- 在该用户的交互式桌面会话中启动 GitHub Runner；不要注册为无桌面的 Windows Service。
- 允许启动 Electron UI，并保持显示会话可用。
- 能访问 GitHub、SignPath、`zz-cn.lingzhiwuxian.com`、`uclaw-ver.oss-cn-beijing.aliyuncs.com` 和生产 SSH。
- 安装 Windows OpenSSH Client。
- 在 `%TEMP%\uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe` 放置已验证的 ossutil。

## DPAPI 凭证

凭证只保存在 Runner 用户的：

```text
%APPDATA%\UClaw\release-credentials\
  live-registration-admin.json
  oss-release.json
  production-ssh.json
```

它们不得提交到 Git、写入 Actions secrets、命令参数、环境变量、日志或报告。DPAPI 文件必须由实际运行 Runner 的同一 Windows 用户创建。

现有 OSS 和 SSH 文件继续使用：

- `oss-release.json`：`accessKeySecretDpapi` 为 PowerShell `ConvertFrom-SecureString` 输出。
- `production-ssh.json`：`passwordDpapi` 为 PowerShell `ConvertFrom-SecureString` 输出。

Live 管理员文件使用完整记录加密，结构只有：

```json
{
  "schemaVersion": 1,
  "recordDpapi": "<DPAPI encrypted JSON>"
}
```

在 Runner 用户会话中用无回显方式初始化：

```powershell
$directory = Join-Path $env:APPDATA 'UClaw\release-credentials'
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$username = Read-Host 'Release regression admin username'
$securePassword = Read-Host 'Release regression admin password' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $record = [pscustomobject]@{
    username = $username
    password = $password
  } | ConvertTo-Json -Compress
  $recordDpapi = ConvertFrom-SecureString (
    ConvertTo-SecureString $record -AsPlainText -Force
  )
  [pscustomobject]@{
    schemaVersion = 1
    recordDpapi = $recordDpapi
  } | ConvertTo-Json | Set-Content (
    Join-Path $directory 'live-registration-admin.json'
  ) -Encoding UTF8
} finally {
  $password = $null
  $record = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
```

管理员账号必须只用于回归：工作流会在内存中创建一次性激活码和随机临时用户，通过最终成品 UI 完成注册、激活、退出、重启和重登，Live 完成后删除临时用户。

## Actions 执行内容

托管 Runner：

- 精确 `master`、版本号、完整 commit 和 clean checkout。
- `pnpm install --frozen-lockfile`。
- `typecheck`、Source Electron E2E、comms replay/compare、harness。
- `package:win:usb` 的初始 Full。
- SignPath 深度签名。
- 根据签名后的最终 ZIP 重算 size/SHA-512。
- 对签名后的最终 ZIP 再执行一次 Full。
- 固化 `candidate.json`、源码结果和 Full summary。

自托管 Runner：

- 空白隔离 profile。
- 全新账号注册、一次性激活、设备激活、Relay Token 和 Runtime 初始化。
- 退出、重启、刚注册账号重登。
- 真实 Responses 文本、图片、视频、充值只读和渠道健康。
- 临时账号清理。
- Full、Live、metadata、build ID、commit、size、SHA-512 对应同一候选包。
- 生成合并中文报告和能力结果 JSON；它们用于发布证据，不再作为额外的聚合门禁脚本。

## 生产写入

`publish-portable-release.ps1`：

- 发布前要求公网更新接口可读；无法确认当前线上版本时禁止生产写入。
- 拒绝把较旧版本覆盖到线上。
- 同一版本若已存在但 size/SHA-512 不同，直接失败，不允许替换不可变成品。
- ZIP 和 JSON 分别探测并校验；上次只成功上传 ZIP 时，重跑只补传缺失 JSON，任何已存在但不匹配的对象仍会阻断。
- 上传到 `oss://uclaw-ver/releases/latest/`。
- 验证 HTTP 200、Content-Length、Content-Type、Accept-Ranges、ZIP 文件头和远端 JSON。
- 动态寻找 Kubernetes 中唯一的 PostgreSQL 容器。
- 锁定发布表，在一个 `ON_ERROR_STOP` 事务中校验版本递增、同版本不可变元数据和重复行，再切换 `claw_x_releases`。
- 断言只有一个 `latest/win/x64/portable_zip` 记录启用。
- 轮询公网更新接口并逐字段核对。
- 公网回读无法收敛时，禁用新候选并恢复发布前启用记录；此前没有启用记录时也不会遗留半发布版本。
- 成功后写出不含凭证的 `publication.json`。

发布器可以幂等重跑：线上已经是完全相同的版本和哈希时，不会重写不可变 OSS 对象。

## 产物

Actions 和 GitHub Release 保留：

- `UClaw-<version>-win-x64-usb.zip`
- `UClaw-<version>-win-x64-usb.json`
- 完整中文回归报告
- `production-capability-results.json`
- `publication.json`

最终公网接口：

```text
https://zz-cn.lingzhiwuxian.com/api/clawx/updates/latest?channel=latest&platform=win&arch=x64&package_type=portable_zip
```

## 故障处理

- 构建、签名、Full 或 Live 失败：没有生产写入，修复代码后从 `develop` 重新走测试。
- OSS 上传失败：feed 不会更新；重跑同一次工作流，发布器会保留并复核已成功上传的精确对象，只补缺失对象。
- 数据库事务失败：旧 release 保持启用；修复连接后重跑。
- 公网回读失败：脚本尝试恢复旧记录，并让工作流失败。
- OSS/feed 已成功但 GitHub Release 失败：重跑同版本；发布器识别完全相同的线上版本后只完成标签/Release 收尾。
