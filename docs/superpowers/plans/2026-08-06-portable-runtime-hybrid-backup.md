# Windows 便携运行时混合备份实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Windows 便携模式从周期性全量 U 盘快照改为本机高速运行、U 盘增量对象备份，并保持 v1 快照恢复兼容。

**Architecture:** 新增独立的 v2 内容寻址快照模块，按本机文件元数据识别变化，只把新内容写入 U 盘，并用原子 manifest 表示完整恢复点。现有 `portable-runtime-state.ts` 继续负责 portableId、运行目录准备和 v1 回退，通过小型适配接入 v2 同步与恢复。

**Tech Stack:** Electron Main、Node.js `fs`/`crypto`、TypeScript、Vitest、Windows packaged E2E。

**Repository rule:** 本计划不包含自动 `git commit` 或 `git push`；只有用户明确要求后才执行提交操作。

---

## 文件结构

- Create: `electron/utils/portable-runtime-snapshot-v2.ts`
  - 定义 v2 manifest、内容对象存储、增量扫描、稳定文件处理、清理和恢复。
- Modify: `electron/utils/portable-runtime-state.ts`
  - 扩展 portable layout，优先恢复 v2，保留 v1/legacy 回退，并让服务调用 v2 同步。
- Modify: `electron/main/index.ts`
  - 保持现有启动方式；退出时在 Gateway 停止后执行有期限的最终同步。
- Create: `tests/unit/portable-runtime-snapshot-v2.test.ts`
  - 覆盖 v2 增量、原子性、不稳定文件、清理及安全恢复。
- Modify: `tests/unit/portable-runtime-state.test.ts`
  - 覆盖 v2 → v1 → legacy 的恢复优先级和现有行为兼容。
- Modify: `tests/packaged-e2e/portable-regression.spec.ts`
  - 将便携持久化检查扩展到 v2 manifest，并验证重新启动恢复。

---

### Task 1: 锁定 v2 数据契约与路径安全

**Files:**
- Create: `electron/utils/portable-runtime-snapshot-v2.ts`
- Create: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 写 manifest 校验与路径安全失败测试**

测试构造合法 manifest、绝对路径条目、`../` 穿越条目、错误 schema 和 portableId 不匹配，要求只接受合法 manifest：

```typescript
it('rejects unsafe or foreign manifests', async () => {
  const layout = await createV2Layout();
  await writeManifest(layout, {
    schema: 'uclaw.portable-runtime-snapshot/v2',
    portableId: layout.portableId,
    createdAt: '2026-08-06T00:00:00.000Z',
    reason: 'test',
    entries: {
      '../outside.json': { object: 'a'.repeat(64), size: 1, mtimeMs: 1 },
    },
  });

  expect(readLatestPortableSnapshotV2Sync(layout)).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试并确认因 v2 API 不存在而失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，提示无法导入 `portable-runtime-snapshot-v2` 或缺少导出函数。

- [ ] **Step 3: 实现最小数据类型和安全校验**

生产模块导出以下稳定接口：

```typescript
export const PORTABLE_SNAPSHOT_V2_SCHEMA = 'uclaw.portable-runtime-snapshot/v2' as const;

export type PortableSnapshotV2Layout = {
  stateDir: string;
  snapshotDir: string;
  portableId: string;
};

export type PortableSnapshotV2Entry = {
  object: string;
  size: number;
  mtimeMs: number;
};

export type PortableSnapshotV2Manifest = {
  schema: typeof PORTABLE_SNAPSHOT_V2_SCHEMA;
  portableId: string;
  createdAt: string;
  reason: string;
  entries: Record<string, PortableSnapshotV2Entry>;
};

export function readLatestPortableSnapshotV2Sync(
  layout: PortableSnapshotV2Layout,
): PortableSnapshotV2Manifest | undefined;
```

相对路径统一使用 `/`；拒绝空路径、绝对路径、`.`、`..` 路径段、反斜杠逃逸、非 64 位小写十六进制对象哈希、负数大小和无效时间。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

---

### Task 2: 建立首次 v2 基线并实现无变化零写入

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 写首次基线与无变化测试**

测试先写入 `openclaw.json` 和 `agents/main.json`，首次同步应产生两个对象和一个 manifest；第二次不修改文件，同步结果必须是 `skipped: true`，对象和 manifest 数量不变：

```typescript
const first = await syncPortableRuntimeSnapshotV2(layout, 'periodic');
expect(first).toMatchObject({ skipped: false, changedFiles: 2, writtenObjects: 2 });

const second = await syncPortableRuntimeSnapshotV2(layout, 'periodic');
expect(second).toMatchObject({ skipped: true, changedFiles: 0, writtenObjects: 0 });
expect(await listManifests(layout)).toHaveLength(1);
expect(await listObjects(layout)).toHaveLength(2);
```

同时写入 `.uclaw-runtime-state.json`，修改该文件后仍必须判定为无业务变化。

- [ ] **Step 2: 运行测试确认当前失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，提示缺少同步函数或第二轮仍产生写入。

- [ ] **Step 3: 实现扫描、哈希、对象写入和原子 manifest**

导出结果类型：

```typescript
export type PortableSnapshotV2SyncResult = {
  skipped: boolean;
  snapshotPath?: string;
  scannedFiles: number;
  changedFiles: number;
  reusedFiles: number;
  writtenObjects: number;
  writtenBytes: number;
  unstableFiles: number;
  scanDurationMs: number;
  writeDurationMs: number;
  totalDurationMs: number;
};

export async function syncPortableRuntimeSnapshotV2(
  layout: PortableSnapshotV2Layout,
  reason?: string,
): Promise<PortableSnapshotV2SyncResult>;
```

实现规则：

- 递归读取本机 `stateDir`，跳过符号链接。
- 文件元数据扫描按固定批次处理，最大并发 32。
- 上一 manifest 中相同路径的 `size` 和 `mtimeMs` 相同则直接复用对象。
- 变化文件先检查稳定性，再计算 SHA-256。
- 新对象写入 `objects/<前两位>/<hash>.<pid>.<uuid>.tmp`，完成后原子重命名为哈希文件。
- manifest 写入 `manifests/.snapshot-*.tmp`，完整落盘后原子重命名。
- manifest 内容与上一份完全一致时不发布新快照。
- `.uclaw-runtime-state.json`、根目录 `logs/tmp/cache/node-compile-cache/plugin-skills`、`.lock`、`.tmp` 不进入扫描结果。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

---

### Task 3: 只写变化文件并处理新增、修改、删除

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 写增删改恢复点测试**

基线包含 `a.json`、`b.json`；随后修改 `a.json`、删除 `b.json`、新增 `c.json`。第二次同步应只处理两个变化文件，发布的新 manifest 不包含 `b.json`：

```typescript
expect(result).toMatchObject({
  skipped: false,
  changedFiles: 2,
  reusedFiles: 0,
  writtenObjects: 2,
});
expect(latest.entries['b.json']).toBeUndefined();
expect(Object.keys(latest.entries).sort()).toEqual(['a.json', 'c.json']);
```

- [ ] **Step 2: 运行测试确认失败原因是增删改尚未完整实现**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，实际 manifest 或统计不符合断言。

- [ ] **Step 3: 补齐变更集合和内容去重**

删除仅更新 manifest，不删除仍被旧 manifest 引用的对象。变化文件哈希与已有对象相同时复用对象并令 `writtenObjects` 保持 0，但 `changedFiles` 仍计数。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

---

### Task 4: 处理 Chromium 缓存、活跃文件和 SQLite 文件组

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 写路径排除测试**

测试排除以下可重建目录，同时保留 Cookies、Local Storage、IndexedDB：

```text
browser/openclaw/user-data/Default/Cache
browser/openclaw/user-data/Default/Code Cache
browser/openclaw/user-data/Default/GPUCache
browser/openclaw/user-data/Crashpad
browser/openclaw/user-data/Default/Service Worker/CacheStorage
```

- [ ] **Step 2: 写不稳定文件和 SQLite 组回退测试**

通过注入测试用文件操作钩子，在复制期间修改 `history.db-wal`。要求 `history.db`、`history.db-wal`、`history.db-shm` 整组沿用上一 manifest；其他稳定变化仍可发布：

```typescript
expect(next.entries['history.db']).toEqual(previous.entries['history.db']);
expect(next.entries['history.db-wal']).toEqual(previous.entries['history.db-wal']);
expect(result.unstableFiles).toBeGreaterThan(0);
expect(next.entries['agents/main.json']).not.toEqual(previous.entries['agents/main.json']);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，缓存仍被扫描或数据库组出现新旧混用。

- [ ] **Step 4: 实现明确排除规则和稳定组处理**

路径规则按不区分大小写的路径段匹配，不能用模糊子串。数据库伴随文件识别后缀 `-wal`、`-shm`、`-journal`，与主文件组成一个原子逻辑组。组处理前后分别读取全部成员元数据；任何成员变化时整组回退上一版本。首次基线没有上一版本时，不发布 manifest。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

---

### Task 5: 保留三份 manifest 并安全回收对象

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 写保留与垃圾回收测试**

连续发布四个不同恢复点，断言只保留最新三个 manifest；前三个保留 manifest 引用的对象全部存在，只有不再被任何保留 manifest 引用的对象被删除。无法解析的 manifest 不得参与恢复，也不得触发扩大范围删除。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: FAIL，manifest 或对象数量未清理。

- [ ] **Step 3: 实现保守清理**

清理顺序固定为：发布新 manifest → 删除第 4 份及更旧的有效 manifest → 汇总保留 manifest 引用 → 删除 `objects` 下未引用且文件名严格符合哈希格式的对象 → 清理已过期 `.tmp`。任何读取错误都停止对象 GC，不影响刚发布快照。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts`

Expected: PASS。

---

### Task 6: 实现 v2 恢复并保持 v1/legacy 回退

**Files:**
- Modify: `electron/utils/portable-runtime-snapshot-v2.ts`
- Modify: `electron/utils/portable-runtime-state.ts`
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`
- Modify: `tests/unit/portable-runtime-state.test.ts`

- [ ] **Step 1: 写 v2 完整恢复测试**

建立两个 v2 manifest，破坏最新 manifest 的一个对象，清空本机 state，要求恢复器跳过损坏快照并恢复上一份完整快照。对象哈希校验使用分块读取，不能把大文件一次性读入内存。

- [ ] **Step 2: 写恢复优先级测试**

同时存在 v2、v1 和 legacy 时恢复 v2；v2 损坏时恢复 v1；两者都不可用时恢复 legacy。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts tests/unit/portable-runtime-state.test.ts`

Expected: FAIL，当前只认识 v1 和 legacy。

- [ ] **Step 4: 实现同步恢复接口并接入 layout**

新增：

```typescript
export function restorePortableRuntimeSnapshotV2Sync(
  layout: PortableSnapshotV2Layout,
  targetDir: string,
): boolean;
```

`PortableRuntimeLayout` 新增 `snapshotV2Dir`，值为 `path.join(dataDir, 'runtime-snapshots-v2')`。`preparePortableRuntimeState()` 仅在本机 state 为空时按 v2 → v1 → legacy 顺序恢复；恢复失败必须清理本轮写入的临时目标，不能留下半恢复目录。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts tests/unit/portable-runtime-state.test.ts`

Expected: PASS。

---

### Task 7: 将定时服务切换到 v2 并增加汇总日志

**Files:**
- Modify: `electron/utils/portable-runtime-state.ts`
- Modify: `tests/unit/portable-runtime-state.test.ts`

- [ ] **Step 1: 写服务互斥、无变化和日志测试**

使用短间隔和可注入同步函数验证：同步中再次触发不会启动第二轮；无变化记录 `skipped`；成功日志包含扫描数、变化数、写入对象数、写入字节及各阶段耗时；错误只记录 deferred，不向调用方抛出导致应用退出。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: FAIL，当前服务调用 v1 全量同步且日志字段不足。

- [ ] **Step 3: 将 `PortableRuntimeSnapshotService` 切换到 v2**

保留 `start()`、`stop()`、`sync(reason)` 公共形状和 `inFlight` 语义。周期仍为 5 分钟，但只进行本机元数据扫描；日志不输出完整用户文件路径。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/portable-runtime-state.test.ts`

Expected: PASS。

---

### Task 8: 给退出最终同步增加明确时间上限

**Files:**
- Modify: `electron/main/index.ts`
- Modify: `tests/unit/quit-lifecycle.test.ts`

- [ ] **Step 1: 写最终同步超时行为测试**

抽取或扩展可测试的退出收尾函数，验证 Gateway 已停止后等待快照；快照在 10 秒内未完成时记录警告并继续退出；成功时不等待超时计时器。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/unit/quit-lifecycle.test.ts`

Expected: FAIL，当前快照等待没有独立时间上限。

- [ ] **Step 3: 实现有期限最终同步**

退出顺序保持：停止周期任务 → 等待 Gateway 停止或强制终止 → `Promise.race` 等待 v2 最终同步最多 10 秒 → 标记 cleanup 完成 → `app.quit()`。超时不能取消正在进行的裸 Promise 后继续访问已退出资源，因此 v2 同步函数需要接受 `AbortSignal`，在文件边界检查取消并清理临时文件。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run tests/unit/quit-lifecycle.test.ts tests/unit/portable-runtime-state.test.ts`

Expected: PASS。

---

### Task 9: 更新 packaged E2E 持久化验证

**Files:**
- Modify: `tests/packaged-e2e/portable-regression.spec.ts`

- [ ] **Step 1: 扩展便携快照场景**

在 `persistence.relaunch` 中等待完整 v2 manifest，校验 schema、portableId、对象存在，并创建一个时间更新但对象缺失的损坏 manifest。迁移到新的 `osHome` 后必须成功启动、跳过损坏 manifest，并恢复上一完整状态。

- [ ] **Step 2: 运行可在当前平台执行的静态检查**

Run: `pnpm run typecheck:node`

Expected: PASS。

- [ ] **Step 3: 在 Windows 便携包执行核心回归**

Run: `pnpm run test:packaged:win`

Expected: `portable.runtime-state`、`persistence.relaunch` 和 Gateway 核心场景 PASS。

如果当前机器无法执行 Windows 包测试，最终反馈必须明确标记为待 Windows 实机验证，不能用 macOS 单测替代该结论。

---

### Task 10: 性能基准与最终回归

**Files:**
- Modify: `tests/unit/portable-runtime-snapshot-v2.test.ts`

- [ ] **Step 1: 增加 5,000 文件回归样本**

测试建立基线后再次同步，断言第二轮 `writtenObjects === 0`、`writtenBytes === 0`、manifest 数不增加。测试不使用苛刻墙钟阈值，避免 CI 抖动；耗时只输出诊断。

- [ ] **Step 2: 运行便携快照相关测试**

Run: `pnpm exec vitest run tests/unit/portable-runtime-snapshot-v2.test.ts tests/unit/portable-runtime-state.test.ts tests/unit/quit-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 3: 运行 Node 类型检查与完整单测**

Run: `pnpm run typecheck:node`

Expected: PASS。

Run: `pnpm test`

Expected: PASS；若存在预先失败，记录与本轮改动无关的失败用例和证据。

- [ ] **Step 4: 检查改动范围**

Run: `git diff --check`

Expected: 无空白错误。

Run: `git status --short`

Expected: 只包含本计划文档、快照实现及对应测试，不混入无关文件。

---

## 回滚方案

如果 v2 在 Windows 实机验证中出现恢复或性能异常：

1. 保留所有已生成的 v2 文件，不执行破坏性删除。
2. 将 `PortableRuntimeSnapshotService` 临时切回 v1 同步入口。
3. `preparePortableRuntimeState()` 禁用 v2 优先恢复，继续从现有 v1 快照恢复。
4. 因首版不删除 v1，回滚不需要数据格式逆向迁移。

回滚只改变客户端选择哪个快照格式，不修改 OpenClaw 本机运行目录。
