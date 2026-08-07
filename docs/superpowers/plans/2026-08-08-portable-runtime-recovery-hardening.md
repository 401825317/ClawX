# Windows 便携数据快照与恢复加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows 便携模式在多电脑切换、异常拔盘、portable ID 丢失和 SQLite 活跃写入时的数据倒退或不可恢复风险，同时降低无变化状态下的周期扫描开销。

**Architecture:** 保留“本机高速运行 + U 盘内容寻址快照”的现有结构，在 v2 manifest 上增加单调代际和父快照信息，并在本机 marker 中记录最近应用的 U 盘快照。启动时比较两端代际；U 盘更新时恢复最新版本，异常退出留下的本地状态先原子改名保留，再恢复 U 盘版本。对象和 manifest 在发布前执行文件同步，SQLite 使用 Node 原生在线备份生成单文件一致快照；文件监听只作为脏标记提示，周期完整扫描继续作为漏事件兜底。

**Tech Stack:** Electron Main、Node.js `fs`/`node:sqlite`、TypeScript、Vitest、Windows packaged E2E。

**Repository rule:** 不执行 `git commit`、`git push`，并避开当前工作区已有的 ACP 流式补丁改动。

---

### Task 1: 快照代际和多电脑恢复

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `electron/utils/portable-runtime-state.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`
- Modify: `tests/unit/portable-runtime-state.test.ts`

- [x] **Step 1: 写失败测试**

增加两个恢复点，模拟本机 marker 停留在第一代但 U 盘已有第二代，且本机 state 非空。启动准备后必须恢复第二代；如果 marker 表示上次异常退出，则原本地目录必须保留到 profile 的 recovery 目录。

```typescript
expect(preparePortableRuntimeState(layout)).toMatchObject({
  source: 'v2',
  snapshotGeneration: 2,
});
expect(await readFile(join(layout.stateDir, 'state.json'), 'utf8')).toContain('usb-v2');
expect(await readdir(join(layout.profileDir, 'recovery'))).toHaveLength(1);
```

- [x] **Step 2: 验证测试因当前非空目录直接返回而失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: FAIL，实际内容仍为旧本地状态。

- [x] **Step 3: 实现代际和启动比较**

新 manifest 写入 `snapshotId`、`generation`、`parentSnapshotId`；旧 v2 manifest 兼容为 generation 0。`RuntimeMarker` 写入 `lastAppliedSnapshotId`、`lastAppliedGeneration`、`lifecycle: active|clean`。启动时 U 盘代际较新则恢复 U 盘；异常退出的本地目录先同卷改名保留，恢复失败再原子回滚。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts tests/unit/portable-runtime-state.test.ts`

Expected: PASS。

### Task 2: portable ID 冗余与找回

**Files:**
- Modify: `electron/utils/portable-runtime-state.ts`
- Modify: `tests/unit/portable-runtime-state.test.ts`

- [x] **Step 1: 写失败测试**

删除 `UClawData/.uclaw-portable-id`，保留根目录镜像或唯一 v2 manifest；重新解析 layout 后必须继续使用原 ID，不能创建新 profile。

- [x] **Step 2: 验证当前生成随机新 ID**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: FAIL，第二次 portableId 与原 ID 不同。

- [x] **Step 3: 实现冗余 ID**

优先级固定为：`UClawData/.uclaw-portable-id` → 便携根目录 `.uclaw-portable-id` → 唯一有效快照中的 portableId → 新 UUID。成功确定 ID 后尽力补写两个 ID 文件；多个不同快照 ID 时不猜测。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: PASS。

### Task 3: 耐久提交和 SQLite 在线备份

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [x] **Step 1: 写失败测试**

使用真实 WAL 模式 SQLite 数据库建立快照，manifest 只保存一致的主数据库对象，不保存 `-wal/-shm`；恢复后用 `DatabaseSync` 查询必须包含提交记录。注入同步观察器，断言对象临时文件和 manifest 临时文件均在 rename 前完成文件同步，cleanup 发生在 manifest 发布之后。

- [x] **Step 2: 验证当前仍复制 db/wal 文件组且没有耐久同步**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，manifest 仍包含 WAL 或同步事件缺失。

- [x] **Step 3: 实现在线备份和耐久发布**

识别 SQLite 文件头后，用 `node:sqlite` 的 `backup()` 写入本地临时数据库，再将该一致副本写成对象。普通文件保持稳定性检查。对象和 manifest 临时文件执行 `FileHandle.sync()` 后 rename，并尽力同步父目录；只有 manifest 耐久发布后才能清理旧 manifest 和对象。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

### Task 4: ClawX 核心状态恢复保护

**Files:**
- Create: `electron/utils/portable-clawx-state.ts`
- Modify: `electron/utils/portable-mode.ts`
- Modify: `electron/main/index.ts`
- Create: `tests/unit/portable-clawx-state.test.ts`

- [x] **Step 1: 写失败测试**

备份 `settings.json`、`clawx-providers.json`、设备身份和激活文件，排除 `electron-session`、日志和缓存。删除 `UClawData/clawx` 后，使用同一 portableId 启动必须从本机 recovery 副本恢复核心 JSON；损坏副本不得覆盖新建目录。

- [x] **Step 2: 验证当前没有 ClawX userData 恢复能力**

Run: `pnpm exec vitest run tests/unit/portable-clawx-state.test.ts`

Expected: FAIL，缺少 portable ClawX state API。

- [x] **Step 3: 实现最小核心状态副本**

只保护顶层持久 JSON 文件，不复制 `electron-session`、缓存、日志、更新包和临时文件。副本保存在本机 profile recovery 目录，并在 `app.setPath('userData')` 前只对缺失/空目录执行恢复；不改变 Electron safeStorage 和登录接管逻辑。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-clawx-state.test.ts`

Expected: PASS。

### Task 5: 脏标记驱动同步和完整验证

**Files:**
- Modify: `electron/utils/portable-runtime-state.ts`
- Modify: `electron/main/index.ts`
- Modify: `tests/unit/portable-runtime-state.test.ts`
- Modify: `tests/packaged-e2e/portable-regression.spec.ts`

- [x] **Step 1: 写失败测试**

没有文件变更时连续周期 tick 不调用 v2 扫描；收到文件变化后下一周期执行一次；监听不可用或达到一小时完整校验窗口时仍执行扫描。正常退出只有最终快照成功后才把 marker 标记为 clean。

- [x] **Step 2: 验证当前每 5 分钟无条件扫描**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: FAIL，第二个周期仍执行扫描。

- [x] **Step 3: 实现脏标记与保底校验**

Windows 使用递归 `fs.watch` 只设置 dirty，不以监听事件作为正确性来源。dirty 时沿用 5 分钟同步；无事件时不访问 U 盘；每 60 分钟执行一次完整一致性扫描。退出停止 watcher，执行有期限最终同步并更新 clean marker。

- [x] **Step 4: 运行回归**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts tests/unit/portable-runtime-state.test.ts tests/unit/portable-clawx-state.test.ts`

Run: `pnpm run typecheck`

Expected: PASS。

- [ ] **Step 5: Windows 便携包验收**

Run: `pnpm run test:packaged:win`

验证新电脑恢复、A→B→A 切换、强制结束、只读/拔盘、portable ID 文件丢失和 ClawX 核心 JSON 恢复。非 Windows 环境无法替代该项结论。
