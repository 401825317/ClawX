# UClaw Windows USB 与 macOS 正式候选暂存

正式候选使用 `.github/workflows/uclaw-portable-production.yml`。该工作流构建 Windows USB ZIP 和 macOS x64/arm64 包，完成平台签名、公证、制品完整性校验、OSS 上传，并在 zz-cn 登记为禁用版本。

该工作流只执行 `stage`：所有新记录固定为 `enabled=false`，不会切换现有客户端更新 Feed，不创建 Git 标签，也不创建或更新 GitHub Release。启用版本必须走独立审批和激活流程。

正式发布不执行源码 E2E、成品 Full、托管 Live、新用户注册、激活或重登回归。回归脚本继续保留为独立 QA 工具，但不属于发包步骤，也不阻断正式发布。

旧的 `release.yml` 仍是通用多平台 Electron 流程，目标 OSS 也不同，不是 UClaw 生产暂存入口。

## 本地正式候选包

在 Windows 的干净 Git 工作区中运行：

```powershell
pnpm release
```

该命令执行 `package:win:usb`，生成当前稳定版本和完整 commit 对应的 USB ZIP/JSON，并核对文件名、版本、commit、build ID、size 和 SHA-512。它不运行功能回归，不调用 SignPath，不上传 OSS，不修改生产 feed，也不创建 Git 标签或 GitHub Release。

## 发布顺序

1. 确认待发布代码位于负责人批准的发布分支远端最新提交，`package.json` 使用新的稳定版本号。
2. 从该发布分支手动运行 `UClaw Windows USB and macOS Production Stage`，输入与 `package.json` 相同的版本号。
3. GitHub 托管 Windows Runner 安装锁定依赖、构建 USB ZIP、提交主程序和便携更新器给 SignPath、验证签名并重算 ZIP/JSON 元数据。
4. GitHub 托管 macOS Runner 构建 x64/arm64 DMG 和 ZIP，完成 Developer ID 签名、公证，并验证签名与 stapled ticket。
5. 工作流把 Windows 和 macOS 精确制品及候选元数据固化为不可变 Actions 制品。
6. 审批 `uclaw-production` Environment。
7. 受保护的 `uclaw-release` Runner 上传版本化 OSS 对象，并在一个数据库事务中登记三条 `enabled=false` 记录。
8. 发布器回读 Windows、macOS x64 和 macOS arm64 公网接口，要求它们与暂存前完全一致。

## GitHub 配置

仓库需要：

- Default branch 为 `master`。
- Secret `SIGNPATH_API_TOKEN`。
- Secrets `MAC_CERTS`、`MAC_CERTS_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- Environment `uclaw-production`，建议配置 required reviewers、禁止 self-review，并将 deployment branch 限制为获准的发布分支或受控分支模式。
- 一台带 `self-hosted`、`Windows`、`X64`、`uclaw-release` 标签的受保护 Windows Runner。

生产 Runner 不需要交互式桌面或 Electron UI。它必须能访问 GitHub、`uclaw-ver.oss-cn-beijing.aliyuncs.com`、`zz-cn.lingzhiwuxian.com` 和生产 SSH，并安装 Windows OpenSSH Client；`ossutil.exe` 固定放在：

```text
%TEMP%\uclaw-ossutil\ossutil-2.3.0-windows-amd64\ossutil.exe
```

## DPAPI 凭证

生产凭证只保存在 Runner 用户目录：

```text
%APPDATA%\UClaw\release-credentials\
  oss-release.json
  production-ssh.json
```

- `oss-release.json` 的 `accessKeySecretDpapi` 是 PowerShell `ConvertFrom-SecureString` 输出。
- `production-ssh.json` 的 `passwordDpapi` 是 PowerShell `ConvertFrom-SecureString` 输出。
- 凭证不得提交到 Git、写入 Actions 参数或环境变量，也不得进入日志、报告或制品。
- DPAPI 文件必须由实际运行 Runner 的同一 Windows 用户创建。

正式发布不再需要 `live-registration-admin.json`。

## 制品校验

正式发布保留以下硬校验；它们属于发包完整性，不是功能回归：

- 触发分支必须是负责人批准分支的远端最新提交，checkout 必须干净。
- 输入版本必须是稳定语义版本，并与 `package.json` 一致。
- 工作流从 `win-unpacked` 提交 `UClaw.exe` 和便携更新器给 SignPath，使用 `ValueCell` 项目的默认 artifact configuration；签名后放回原目录并重建 ZIP，两份 Authenticode 签名必须有效。
- macOS x64/arm64 应用必须通过 `codesign --verify`、Gatekeeper assessment 和 DMG stapler 校验；自动更新记录指向 ZIP，DMG 同时上传供人工下载安装。
- 签名后重新计算 JSON，version、commit、build ID、文件名、size 和 SHA-512 必须对应最终 ZIP 字节。
- OSS 必须返回 HTTP 200、精确 `Content-Length`、Range 支持、允许的 Content-Type 和 ZIP 文件头，远端 JSON 必须与本地一致。
- `claw_x_releases` 更新在 `ON_ERROR_STOP` 事务中完成；Windows portable、macOS x64 和 macOS arm64 三条候选必须全部为禁用状态。
- 暂存事务前后的所有既有启用记录必须完全一致，公网更新接口不得出现候选版本。

## 独立回归

回归不在正式发布工作流中自动运行。需要 QA 时单独执行：

```powershell
pnpm run test:e2e
pnpm run test:packaged:win:full
pnpm run test:packaged:win:live
```

详细隔离和凭证规则见 `PACKAGED_REGRESSION.md`。回归结果不会被 `stage-production-release-candidate.mjs` 或生产发布 Action 读取。

## 暂存产物

Actions 和 OSS 保留：

- `UClaw-<version>-win-x64-usb.zip`
- `UClaw-<version>-win-x64-usb.json`
- `UClaw-<version>-mac-x64.dmg` / `.zip`
- `UClaw-<version>-mac-arm64.dmg` / `.zip`
- 对应的 macOS `.zip.blockmap`
- `UClaw-<version>-mac.json`
- `stage-publication.json`

最终公网接口：

```text
https://zz-cn.lingzhiwuxian.com/api/clawx/updates/latest?channel=latest&platform=win&arch=x64&package_type=portable_zip
```

## 故障处理

- 构建或签名失败：没有生产写入，修复后重跑。
- OSS 上传失败：feed 不更新；重跑时发布器复核已存在对象，只补传缺失对象。
- 数据库事务失败：旧 release 保持启用，修复连接后重跑。
- 公网回读发生变化：暂存记录仍保持禁用，工作流失败并要求人工核对并发的版本管理操作。
- 同版本同元数据重跑：沿用 OSS 对象和禁用数据库记录；同版本不同 hash、size、URL 或文件名会被拒绝。
