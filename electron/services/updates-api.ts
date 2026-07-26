import type {
  UpdateInfoSnapshot,
  UpdateProgressSnapshot,
  UpdateStatusSnapshot,
} from '@shared/host-api/contract';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { AppUpdater, PortableUpdateInfo, UpdateStatus } from '../main/updater';

function normalizeInfo(info: UpdateStatus['info']): UpdateInfoSnapshot | undefined {
  if (!info) return undefined;
  const portableInfo = info as PortableUpdateInfo;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: typeof info.releaseNotes === 'string' || info.releaseNotes == null ? info.releaseNotes : String(info.releaseNotes),
    downloadUrl: portableInfo.downloadUrl || portableInfo.download_url,
    channel: portableInfo.channel,
    platform: portableInfo.platform,
    arch: portableInfo.arch,
    packageType: portableInfo.packageType || portableInfo.package_type,
    fileName: portableInfo.fileName || portableInfo.file_name,
    sha512: portableInfo.sha512,
    size: portableInfo.size,
    mandatory: portableInfo.mandatory,
  };
}

function normalizeProgress(progress: UpdateStatus['progress']): UpdateProgressSnapshot | undefined {
  if (!progress) return undefined;
  return {
    total: progress.total,
    delta: progress.delta,
    transferred: progress.transferred,
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
  };
}

function normalizeStatus(status: UpdateStatus): UpdateStatusSnapshot {
  return {
    status: status.status,
    mode: status.mode,
    info: normalizeInfo(status.info),
    progress: normalizeProgress(status.progress),
    error: status.error,
    downloadPath: status.downloadPath,
  };
}

export function createUpdatesApi(updater: AppUpdater): CompleteHostServiceRegistry['updates'] {
  return {
    status: () => normalizeStatus(updater.getStatus()),
    version: () => updater.getCurrentVersion(),
    check: async () => {
      try {
        await updater.checkForUpdates();
        return { success: true, status: normalizeStatus(updater.getStatus()) };
      } catch (error) {
        return { success: false, error: String(error), status: normalizeStatus(updater.getStatus()) };
      }
    },
    download: async () => {
      try {
        const result = await updater.downloadUpdate();
        return { success: true, ...result, status: normalizeStatus(updater.getStatus()) };
      } catch (error) {
        return { success: false, error: String(error), status: normalizeStatus(updater.getStatus()) };
      }
    },
    install: async () => {
      try {
        await updater.installDownloadedUpdate();
        return { success: true, status: normalizeStatus(updater.getStatus()) };
      } catch (error) {
        return { success: false, error: String(error), status: normalizeStatus(updater.getStatus()) };
      }
    },
    setChannel: (payload) => {
      updater.setChannel(payload.channel);
      return { success: true };
    },
    setAutoDownload: (payload) => {
      updater.setAutoDownload(payload.enable);
      return { success: true };
    },
    cancelAutoInstall: () => {
      updater.cancelAutoInstall();
      return { success: true };
    },
  };
}
