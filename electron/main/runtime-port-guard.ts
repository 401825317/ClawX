import { app, dialog } from 'electron';
import { resolveSupportedLanguage, type LanguageCode } from '../../shared/language';
import { getSetting } from '../utils/store';
import { logger } from '../utils/logger';
import {
  buildProcessFingerprint,
  findVerifiedUClawOwner,
  getListeningProcessIds,
  inspectProcess,
  isProcessAlive,
  isProcessDescendantOf,
  isVerifiedUClawProcess,
  terminateProcessTree,
  type ProcessDescriptor,
  type VerifiedUClawProcess,
} from '../utils/process-inspection';
import {
  acquireProcessInstanceFileLock,
  type ProcessInstanceFileLock,
} from './process-instance-lock';

const GRACEFUL_EXIT_TIMEOUT_MS = 8_000;
const FORCED_EXIT_TIMEOUT_MS = 5_000;
const EXIT_POLL_INTERVAL_MS = 250;

type RuntimeConflict = {
  resource: 'instance-lock' | 'port';
  label: string;
  lockPath?: string;
  port?: number;
  listenerPid?: number;
  processInfo?: ProcessDescriptor | null;
  owner?: VerifiedUClawProcess | null;
};

type GuardCopy = {
  title: string;
  knownMessage: string;
  unknownMessage: string;
  replace: string;
  keepOld: string;
  retry: string;
  exitNew: string;
  forceTitle: string;
  forceMessage: string;
  force: string;
  cancel: string;
  startupFailureTitle: string;
  startupFailureMessage: string;
  instanceLock: string;
  processUnknown: string;
};

const GUARD_COPY: Record<LanguageCode, GuardCopy> = {
  en: {
    title: 'Another UClaw runtime is active',
    knownMessage: 'A verified UClaw or ClawX process owns a required runtime resource. Close it before starting this version.',
    unknownMessage: 'A required UClaw runtime resource is owned by an unverified process. UClaw will not stop that process automatically.',
    replace: 'Close old version and start this version',
    keepOld: 'Keep using old version',
    retry: 'Retry',
    exitNew: 'Exit this version',
    forceTitle: 'Old UClaw did not exit',
    forceMessage: 'The verified old UClaw process did not exit in time. Force-closing it may interrupt active work.',
    force: 'Force close and continue',
    cancel: 'Cancel',
    startupFailureTitle: 'UClaw could not start',
    startupFailureMessage: 'A required local runtime service failed to start. No Gateway connection was opened.',
    instanceLock: 'Shared UClaw instance lock',
    processUnknown: 'process details unavailable',
  },
  zh: {
    title: '检测到另一个 UClaw 运行时',
    knownMessage: '已确认有旧版 UClaw 或 ClawX 占用必要的运行时资源。启动当前版本前需要先退出旧版。',
    unknownMessage: '必要的 UClaw 运行时资源被无法确认身份的进程占用。为避免误伤，UClaw 不会自动结束该进程。',
    replace: '退出旧版并启动新版',
    keepOld: '继续使用旧版',
    retry: '重试',
    exitNew: '退出新版',
    forceTitle: '旧版 UClaw 未能退出',
    forceMessage: '已确认的旧版 UClaw 未在规定时间内退出。强制结束可能中断旧版中正在执行的任务。',
    force: '强制退出旧版并继续',
    cancel: '取消',
    startupFailureTitle: 'UClaw 无法启动',
    startupFailureMessage: '必要的本地运行时服务启动失败，Gateway 未继续连接。',
    instanceLock: 'UClaw 共享实例锁',
    processUnknown: '无法读取进程详情',
  },
  ja: {
    title: '別の UClaw ランタイムを検出しました',
    knownMessage: '確認済みの UClaw または ClawX プロセスが必要なランタイム資源を使用しています。このバージョンを起動する前に終了してください。',
    unknownMessage: '必要な UClaw ランタイム資源を未確認のプロセスが使用しています。安全のため、そのプロセスは自動終了しません。',
    replace: '旧バージョンを終了して起動',
    keepOld: '旧バージョンを使い続ける',
    retry: '再試行',
    exitNew: 'このバージョンを終了',
    forceTitle: '旧 UClaw を終了できませんでした',
    forceMessage: '確認済みの旧 UClaw プロセスが時間内に終了しませんでした。強制終了すると実行中の作業が中断される場合があります。',
    force: '強制終了して続行',
    cancel: 'キャンセル',
    startupFailureTitle: 'UClaw を起動できません',
    startupFailureMessage: '必要なローカルランタイムサービスを起動できなかったため、Gateway への接続は開始されませんでした。',
    instanceLock: 'UClaw 共有インスタンスロック',
    processUnknown: 'プロセス情報を取得できません',
  },
  ru: {
    title: 'Обнаружена другая среда UClaw',
    knownMessage: 'Проверенный процесс UClaw или ClawX использует обязательный ресурс среды. Перед запуском этой версии его нужно закрыть.',
    unknownMessage: 'Обязательный ресурс UClaw занят непроверенным процессом. UClaw не будет автоматически завершать его.',
    replace: 'Закрыть старую версию и запустить эту',
    keepOld: 'Продолжить работу в старой версии',
    retry: 'Повторить',
    exitNew: 'Закрыть эту версию',
    forceTitle: 'Старая версия UClaw не завершилась',
    forceMessage: 'Проверенный процесс старой версии UClaw не завершился вовремя. Принудительное завершение может прервать текущую работу.',
    force: 'Завершить принудительно и продолжить',
    cancel: 'Отмена',
    startupFailureTitle: 'Не удалось запустить UClaw',
    startupFailureMessage: 'Не удалось запустить обязательную локальную службу. Подключение к Gateway не выполнялось.',
    instanceLock: 'Общая блокировка экземпляра UClaw',
    processUnknown: 'сведения о процессе недоступны',
  },
};

export interface RuntimePortDefinition {
  label: string;
  port: number;
}

export interface RuntimeOwnershipGuardOptions {
  lockDir: string;
  lockName: string;
  ports: RuntimePortDefinition[];
  currentPid?: number;
}

export interface RuntimeOwnershipGuardResult {
  acquired: boolean;
  release: () => void;
}

async function resolveGuardCopy(): Promise<GuardCopy> {
  try {
    return GUARD_COPY[resolveSupportedLanguage(await getSetting('language'))];
  } catch {
    return GUARD_COPY[resolveSupportedLanguage(app.getLocale())];
  }
}

async function describeLockConflict(
  fileLock: ProcessInstanceFileLock,
  copy: GuardCopy,
): Promise<RuntimeConflict> {
  const processInfo = fileLock.ownerPid
    ? await inspectProcess(fileLock.ownerPid)
    : null;
  const owner = fileLock.ownerPid
    ? await findVerifiedUClawOwner(fileLock.ownerPid)
    : null;
  return {
    resource: 'instance-lock',
    label: copy.instanceLock,
    lockPath: fileLock.lockPath,
    listenerPid: fileLock.ownerPid,
    processInfo,
    owner,
  };
}

async function scanPortConflicts(
  ports: RuntimePortDefinition[],
  currentPid: number,
): Promise<RuntimeConflict[]> {
  const conflicts: RuntimeConflict[] = [];
  for (const definition of ports) {
    const listenerPids = await getListeningProcessIds(definition.port);
    for (const listenerPid of listenerPids) {
      if (await isProcessDescendantOf(listenerPid, currentPid)) continue;
      conflicts.push({
        resource: 'port',
        label: definition.label,
        port: definition.port,
        listenerPid,
        processInfo: await inspectProcess(listenerPid),
        owner: await findVerifiedUClawOwner(listenerPid),
      });
    }
  }
  return conflicts;
}

function formatConflict(conflict: RuntimeConflict, copy: GuardCopy): string {
  const processInfo = conflict.owner?.root ?? conflict.processInfo;
  const pid = processInfo?.pid ?? conflict.listenerPid;
  const name = processInfo?.productName || processInfo?.name;
  const version = processInfo?.productVersion;
  const executablePath = processInfo?.executablePath;
  const resource = conflict.port
    ? `${conflict.label} (${conflict.port})`
    : conflict.label;
  const processParts = [
    pid ? `PID ${pid}` : null,
    name || null,
    version ? `v${version}` : null,
    executablePath || null,
  ].filter(Boolean);
  return `- ${resource}: ${processParts.join(' | ') || copy.processUnknown}`;
}

function uniqueVerifiedOwners(conflicts: RuntimeConflict[]): VerifiedUClawProcess[] {
  const owners = new Map<number, VerifiedUClawProcess>();
  for (const conflict of conflicts) {
    if (conflict.owner) owners.set(conflict.owner.root.pid, conflict.owner);
  }
  return [...owners.values()];
}

async function promptConflictResolution(
  conflicts: RuntimeConflict[],
  copy: GuardCopy,
): Promise<'replace' | 'retry' | 'exit-new'> {
  const allVerified = conflicts.length > 0 && conflicts.every((conflict) => Boolean(conflict.owner));
  const details = conflicts.map((conflict) => formatConflict(conflict, copy)).join('\n');
  if (!allVerified) {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: copy.title,
      message: copy.unknownMessage,
      detail: details,
      buttons: [copy.retry, copy.exitNew],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0 ? 'retry' : 'exit-new';
  }

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: copy.title,
    message: copy.knownMessage,
    detail: details,
    buttons: [copy.replace, copy.keepOld, copy.retry],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) return 'replace';
  if (result.response === 2) return 'retry';
  return 'exit-new';
}

async function waitForOwnersToExit(
  owners: VerifiedUClawProcess[],
  timeoutMs: number,
): Promise<VerifiedUClawProcess[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = owners;
  while (Date.now() < deadline) {
    const alive = await Promise.all(remaining.map(async (owner) => ({
      owner,
      alive: await isProcessAlive(owner.root.pid),
    })));
    remaining = alive.filter((entry) => entry.alive).map((entry) => entry.owner);
    if (remaining.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_INTERVAL_MS));
  }
  return remaining;
}

async function terminateVerifiedOwners(
  owners: VerifiedUClawProcess[],
  force: boolean,
): Promise<boolean> {
  for (const owner of owners) {
    const current = await inspectProcess(owner.root.pid);
    if (!current) continue;
    if (
      !isVerifiedUClawProcess(current)
      || buildProcessFingerprint(current) !== owner.fingerprint
    ) {
      logger.warn(
        `[runtime-port-guard] Refusing to terminate PID ${owner.root.pid}: process identity changed after confirmation`,
      );
      return false;
    }
    logger.info(
      `[runtime-port-guard] ${force ? 'Force-closing' : 'Requesting graceful exit from'} verified UClaw process PID ${owner.root.pid}`,
    );
    await terminateProcessTree(owner.root.pid, force);
  }
  return true;
}

async function promptForceTermination(
  owners: VerifiedUClawProcess[],
  copy: GuardCopy,
): Promise<boolean> {
  const details = owners
    .map((owner) => formatConflict({
      resource: 'instance-lock',
      label: copy.instanceLock,
      listenerPid: owner.root.pid,
      processInfo: owner.root,
      owner,
    }, copy))
    .join('\n');
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: copy.forceTitle,
    message: copy.forceMessage,
    detail: details,
    buttons: [copy.force, copy.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

export async function ensureRuntimeOwnership(
  options: RuntimeOwnershipGuardOptions,
): Promise<RuntimeOwnershipGuardResult> {
  const copy = await resolveGuardCopy();
  const currentPid = options.currentPid ?? process.pid;
  let heldLock: ProcessInstanceFileLock | null = null;

  for (;;) {
    const conflicts: RuntimeConflict[] = [];
    if (!heldLock) {
      const fileLock = acquireProcessInstanceFileLock({
        lockDir: options.lockDir,
        lockName: options.lockName,
        pid: currentPid,
      });
      if (fileLock.acquired) {
        heldLock = fileLock;
      } else {
        conflicts.push(await describeLockConflict(fileLock, copy));
      }
    }

    conflicts.push(...await scanPortConflicts(options.ports, currentPid));
    if (conflicts.length === 0 && heldLock) {
      logger.info(
        `[runtime-port-guard] Acquired shared instance lock and verified core ports: ${options.ports.map(({ port }) => port).join(', ')}`,
      );
      return {
        acquired: true,
        release: heldLock.release,
      };
    }

    logger.warn('[runtime-port-guard] Core runtime ownership conflict detected', {
      conflicts: conflicts.map((conflict) => ({
        resource: conflict.resource,
        port: conflict.port,
        listenerPid: conflict.listenerPid,
        verifiedOwnerPid: conflict.owner?.root.pid,
        executablePath: conflict.owner?.root.executablePath ?? conflict.processInfo?.executablePath,
      })),
    });
    const resolution = await promptConflictResolution(conflicts, copy);
    if (resolution === 'exit-new') {
      heldLock?.release();
      return { acquired: false, release: () => {} };
    }
    if (resolution === 'retry') continue;

    const owners = uniqueVerifiedOwners(conflicts);
    if (owners.length === 0 || !await terminateVerifiedOwners(owners, false)) {
      continue;
    }

    const remaining = await waitForOwnersToExit(owners, GRACEFUL_EXIT_TIMEOUT_MS);
    if (remaining.length === 0) continue;
    if (!await promptForceTermination(remaining, copy)) continue;
    if (!await terminateVerifiedOwners(remaining, true)) continue;
    await waitForOwnersToExit(remaining, FORCED_EXIT_TIMEOUT_MS);
  }
}

export async function showRuntimeStartupFailure(error: unknown): Promise<void> {
  const copy = await resolveGuardCopy();
  const errorMessage = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox(
    copy.startupFailureTitle,
    `${copy.startupFailureMessage}\n\n${errorMessage}`,
  );
}
