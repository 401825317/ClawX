# UClaw Windows 便携正式发布

正式 Windows USB ZIP 使用 `.github/workflows/uclaw-portable-production.yml`。该工作流负责构建、SignPath 深度签名、制品完整性校验、OSS 上传、生产更新记录、Git 标签和 GitHub Release。

正式发布不执行源码 E2E、成品 Full、托管 Live、新用户注册、激活或重登回归。回归脚本继续保留为独立 QA 工具，但不属于发包步骤，也不阻断正式发布。

旧的 `release.yml` 仍是通用多平台 Electron 流程，不是 UClaw Windows USB 生产发布入口。

## 本地正式候选包

在 Windows 的干净 Git 工作区中运行：

```powershell
pnpm release
```

该命令执行 `package:win:usb`，生成当前稳定版本和完整 commit 对应的 USB ZIP/JSON，并核对文件名、版本、commit、build ID、size 和 SHA-512。它不运行功能回归，不调用 SignPath，不上传 OSS，不修改生产 feed，也不创建 Git 标签或 GitHub Release。

## 发布顺序

1. 确认待发布代码位于远端最新 `master`，`package.json` 使用新的稳定版本号。
2. 从 `master` 手动运行 `UClaw Windows Portable Production`，输入与 `package.json` 相同的版本号。
3. GitHub 托管 Windows Runner 安装锁定依赖、构建 USB ZIP、提交 SignPath 深度签名、验证签名并重算 ZIP/JSON 元数据。
4. 工作流把精确 ZIP、JSON 和 `candidate.json` 固化为不可变候选制品。
5. 审批 `uclaw-production` Environment。
6. 受保护的 `uclaw-release` Runner 校验候选，上传 OSS，事务更新 `claw_x_releases`，并回读公网更新接口。
7. 创建或核对 annotated tag，创建 GitHub Release，并附上 ZIP、JSON 和 `publication.json`。

## GitHub 配置

仓库需要：

- Default branch 为 `master`。
- Secret `SIGNPATH_API_TOKEN`。
- Variable `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG`，指向可深度签名 ZIP 内 `UClaw.exe` 和便携更新器的 SignPath artifact configuration。
- Environment `uclaw-production`，建议配置 required reviewers、禁止 self-review，并限制 deployment branch 为 `master`。
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

- 触发分支必须是远端最新 `master`，checkout 必须干净。
- 输入版本必须是稳定语义版本，并与 `package.json` 一致。
- ZIP 内 `UClaw.exe` 和便携更新器 Authenticode 签名必须有效。
- 签名后重新计算 JSON，version、commit、build ID、文件名、size 和 SHA-512 必须对应最终 ZIP 字节。
- OSS 必须返回 HTTP 200、精确 `Content-Length`、Range 支持、允许的 Content-Type 和 ZIP 文件头，远端 JSON 必须与本地一致。
- `claw_x_releases` 更新在 `ON_ERROR_STOP` 事务中完成，并且只允许一个 `latest/win/x64/portable_zip` 记录启用。
- 公网更新接口返回的版本、URL、size、SHA-512、package type 和 mandatory 必须与候选一致。

## 独立回归

回归不在正式发布工作流中自动运行。需要 QA 时单独执行：

```powershell
pnpm run test:e2e
pnpm run test:packaged:win:full
pnpm run test:packaged:win:live
```

详细隔离和凭证规则见 `PACKAGED_REGRESSION.md`。回归结果不会被 `stage-production-release-candidate.mjs` 或生产发布 Action 读取。

## 发布产物

Actions 和 GitHub Release 保留：

- `UClaw-<version>-win-x64-usb.zip`
- `UClaw-<version>-win-x64-usb.json`
- `publication.json`

最终公网接口：

```text
https://zz-cn.lingzhiwuxian.com/api/clawx/updates/latest?channel=latest&platform=win&arch=x64&package_type=portable_zip
```

## 故障处理

- 构建或签名失败：没有生产写入，修复后重跑。
- OSS 上传失败：feed 不更新；重跑时发布器复核已存在对象，只补传缺失对象。
- 数据库事务失败：旧 release 保持启用，修复连接后重跑。
- 公网回读失败：发布脚本尝试恢复旧记录并使工作流失败。
- OSS/feed 已成功但 GitHub Release 失败：重跑同一版本；完全一致的线上版本会按幂等路径完成 tag 和 Release。
