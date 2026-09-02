import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useUpdateStore } from '@/stores/update';
import { UpdateToast } from './UpdateToast';

const AVAILABLE_TOAST_ID = 'clawx-update-available';
const DOWNLOADED_TOAST_ID = 'clawx-update-downloaded';

/**
 * Shows global update prompts outside the Settings page.
 *
 * The update store owns IPC communication; this component only reacts to
 * store state changes and presents user-facing actions via a custom
 * Sonner toast (`UpdateToast`) that follows the active ClawX theme.
 */
export function UpdateNotifier() {
  const { t } = useTranslation('settings');
  const status = useUpdateStore((state) => state.status);
  const mode = useUpdateStore((state) => state.mode);
  const packageType = useUpdateStore((state) => state.packageType);
  const canAutoReplace = useUpdateStore((state) => state.canAutoReplace);
  const requiresMigration = useUpdateStore((state) => state.requiresMigration);
  const migrationReason = useUpdateStore((state) => state.migrationReason);
  const disposition = useUpdateStore((state) => state.disposition);
  const updateInfo = useUpdateStore((state) => state.updateInfo);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const installUpdate = useUpdateStore((state) => state.installUpdate);
  const lastAvailableKeyRef = useRef<string | null>(null);
  const lastDownloadedKeyRef = useRef<string | null>(null);

  const isPortablePackage = packageType === 'portable_zip';
  const canInstallPortableInPlace = isPortablePackage
    && disposition === 'auto-replace'
    && canAutoReplace
    && !requiresMigration;
  const requiresManualMigration = isPortablePackage && !canInstallPortableInPlace;

  useEffect(() => {
    const version = updateInfo?.version || t('updates.toast.unknownVersion');
    const dismissLabel = t('updates.action.later');
    // Version alone is not a sufficient identity for a notification.  The
    // same ZIP can move between manual-migration and in-place replacement when
    // the user completes (or loses) a portable root while the app is running.
    // Include all metadata that changes the copy/action so an existing toast
    // cannot retain a stale install callback after that reclassification.
    const notificationKey = JSON.stringify([
      version,
      mode,
      packageType,
      canAutoReplace,
      requiresMigration,
      migrationReason,
      disposition,
      updateInfo?.arch,
      updateInfo?.sha512,
      updateInfo?.downloadUrl,
    ]);

    if (status !== 'available') {
      toast.dismiss(AVAILABLE_TOAST_ID);
      lastAvailableKeyRef.current = null;
    }

    if (status !== 'downloaded') {
      toast.dismiss(DOWNLOADED_TOAST_ID);
      lastDownloadedKeyRef.current = null;
    }

    if (status === 'available') {
      if (lastAvailableKeyRef.current === notificationKey) return;
      // Replace an existing toast when only its disposition/metadata changed.
      // Without this dismissal, Sonner may keep the old custom node and its
      // captured action even though the renderer state has been reclassified.
      toast.dismiss(AVAILABLE_TOAST_ID);
      lastAvailableKeyRef.current = notificationKey;

      toast.custom(
        (toastId) => (
          <UpdateToast
            variant="available"
            title={t('updates.toast.availableTitle')}
            description={requiresManualMigration
              ? t('updates.toast.manualMigrationAvailableDescription', { version })
              : isPortablePackage
                ? t('updates.toast.portableAvailableDescription', { version })
              : t('updates.toast.availableDescription', { version })}
            primaryActionLabel={isPortablePackage
              ? t('updates.action.downloadPortable')
              : t('updates.action.download')}
            dismissLabel={dismissLabel}
            onPrimaryAction={() => {
              toast.dismiss(toastId);
              lastAvailableKeyRef.current = null;
              void downloadUpdate();
            }}
            onDismiss={() => {
              toast.dismiss(toastId);
            }}
          />
        ),
        {
          id: AVAILABLE_TOAST_ID,
          duration: Infinity,
          position: 'bottom-left',
        },
      );
      return;
    }

    if (status === 'downloaded') {
      if (lastDownloadedKeyRef.current === notificationKey) return;
      toast.dismiss(DOWNLOADED_TOAST_ID);
      lastDownloadedKeyRef.current = notificationKey;

      toast.custom(
        (toastId) => (
          <UpdateToast
            variant="downloaded"
            title={t('updates.toast.downloadedTitle')}
            description={requiresManualMigration
              ? t('updates.toast.manualMigrationDownloadedDescription', { version })
              : isPortablePackage
                ? t('updates.toast.portableDownloadedDescription', { version })
              : t('updates.toast.downloadedDescription', { version })}
            primaryActionLabel={requiresManualMigration
              ? t('updates.action.openMigrationPackage')
              : isPortablePackage ? t('updates.action.installPortable') : t('updates.action.install')}
            dismissLabel={dismissLabel}
            onPrimaryAction={() => {
              toast.dismiss(toastId);
              // A manual-migration install only opens the downloaded ZIP and
              // intentionally leaves the updater in `downloaded` state. Keep
              // the dedupe marker in that case; clearing it here would cause
              // the effect to immediately recreate the same toast after the
              // IPC call returns, trapping the user in a toast loop.
              if (!requiresManualMigration) {
                lastDownloadedKeyRef.current = null;
              }
              void installUpdate();
            }}
            onDismiss={() => {
              toast.dismiss(toastId);
            }}
          />
        ),
        {
          id: DOWNLOADED_TOAST_ID,
          duration: Infinity,
          position: 'bottom-left',
        },
      );
    }
  }, [
    canAutoReplace,
    disposition,
    downloadUpdate,
    installUpdate,
    isPortablePackage,
    migrationReason,
    mode,
    packageType,
    requiresManualMigration,
    requiresMigration,
    status,
    t,
    updateInfo?.arch,
    updateInfo?.downloadUrl,
    updateInfo?.sha512,
    updateInfo?.version,
  ]);

  return null;
}

export default UpdateNotifier;
