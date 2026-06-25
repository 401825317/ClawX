import { memo, useMemo, useState } from 'react';
import { Bell, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  getClientAnnouncementKey,
  useClientConfigStore,
  type ClientAnnouncement,
} from '@/stores/client-config';

interface AnnouncementBellProps {
  collapsed?: boolean;
  sidebarOffset?: number;
}

function levelBadgeVariant(level: ClientAnnouncement['level']) {
  if (level === 'urgent') return 'destructive' as const;
  if (level === 'important') return 'warning' as const;
  return 'secondary' as const;
}

function AnnouncementBellComponent(props: AnnouncementBellProps) {
  const { t } = useTranslation(['common']);
  const [open, setOpen] = useState(false);
  const announcements = useClientConfigStore((state) => state.announcements);
  const readKeys = useClientConfigStore((state) => state.readKeys);
  const markAllAnnouncementsRead = useClientConfigStore((state) => state.markAllAnnouncementsRead);
  const markAnnouncementRead = useClientConfigStore((state) => state.markAnnouncementRead);
  const unreadCount = useMemo(
    () => announcements.filter((item) => !readKeys.includes(getClientAnnouncementKey(item))).length,
    [announcements, readKeys],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      markAllAnnouncementsRead();
    }
  };

  const handleOpenLink = async (announcement: ClientAnnouncement) => {
    markAnnouncementRead(announcement);
    if (announcement.link) {
      await window.electron.openExternal(announcement.link);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            data-testid="sidebar-announcements"
            variant="ghost"
            size="icon"
            className={cn(
              'no-drag relative h-8 w-8 shrink-0 rounded-lg text-foreground/80',
              'hover:bg-black/5 hover:text-foreground/80 dark:hover:bg-white/5',
            )}
            onClick={() => handleOpenChange(true)}
            aria-label={t('common:announcements.title')}
          >
            <Bell className="h-[17px] w-[17px]" />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-surface-sidebar" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={props.collapsed ? 'right' : 'bottom'}>
          {t('common:announcements.title')}
        </TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="left"
          className="w-[380px] max-w-[calc(100vw-88px)] border-r p-0 sm:max-w-[420px]"
          style={{ left: props.sidebarOffset ?? 72 }}
        >
          <div className="flex h-full min-h-0 flex-col">
            <SheetHeader className="border-b px-5 py-4 text-left">
              <SheetTitle>{t('common:announcements.title')}</SheetTitle>
              <SheetDescription>
                {t('common:announcements.description')}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {announcements.length === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                  {t('common:announcements.empty')}
                </div>
              ) : (
                <div className="space-y-2">
                  {announcements.map((announcement) => (
                    <div
                      key={getClientAnnouncementKey(announcement)}
                      className="rounded-lg border bg-card p-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">
                            {announcement.title}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {new Date(announcement.publishedAt).toLocaleString()}
                          </div>
                        </div>
                        <Badge variant={levelBadgeVariant(announcement.level)} className="shrink-0">
                          {t(`common:announcements.level.${announcement.level}`)}
                        </Badge>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap leading-6 text-foreground/80">
                        {announcement.content}
                      </p>
                      {announcement.link && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-8 px-2"
                          onClick={() => void handleOpenLink(announcement)}
                        >
                          {t('common:announcements.openLink')}
                          <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export const AnnouncementBell = memo(AnnouncementBellComponent);
