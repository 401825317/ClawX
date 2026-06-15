import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { useClientConfigStore } from '@/stores/client-config';

export function UrgentAnnouncementDialog() {
  const { t } = useTranslation(['common']);
  const announcement = useClientConfigStore((state) => state.urgentAnnouncement);
  const dismissUrgent = useClientConfigStore((state) => state.dismissUrgent);

  if (!announcement) {
    return null;
  }

  const openLink = async () => {
    if (announcement.link) {
      await window.electron.openExternal(announcement.link);
    }
    dismissUrgent(announcement);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl">
        <div className="text-sm font-medium text-red-700 dark:text-red-400">
          {t('common:announcements.urgent')}
        </div>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          {announcement.title}
        </h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
          {announcement.content}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          {announcement.link && (
            <Button variant="outline" onClick={() => void openLink()}>
              {t('common:announcements.openLink')}
            </Button>
          )}
          <Button onClick={() => dismissUrgent(announcement)}>
            {t('common:actions.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
