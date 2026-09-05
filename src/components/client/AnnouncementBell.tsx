import { memo, useCallback, useMemo, useState } from 'react';
import { Archive, Bell, CalendarDays, ExternalLink, Inbox, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import {
  getClientAnnouncementKey,
  isClientAnnouncementRead,
  useAnnouncementsStore,
} from '@/stores/announcements';
import type { ClientAnnouncement } from '@/lib/host-api';

type AnnouncementBellProps = {
  collapsed?: boolean;
  sidebarOffset?: number;
};

type AnnouncementTab = 'latest' | 'history';

function levelBadgeVariant(level: ClientAnnouncement['level']) {
  if (level === 'urgent') return 'destructive' as const;
  if (level === 'important') return 'warning' as const;
  return 'secondary' as const;
}

function levelAccentClass(level: ClientAnnouncement['level']) {
  if (level === 'urgent') return 'border-l-red-500';
  if (level === 'important') return 'border-l-yellow-500';
  return 'border-l-muted-foreground/30';
}

function AnnouncementItem({
  announcement,
  archived,
  onOpenLink,
}: {
  announcement: ClientAnnouncement;
  archived?: boolean;
  onOpenLink: (announcement: ClientAnnouncement) => void;
}) {
  const { t, i18n } = useTranslation('common');
  const formattedDate = new Date(announcement.publishedAt).toLocaleString(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <article
      data-testid={`announcement-${announcement.id}`}
      className={cn(
        'rounded-lg border border-l-[3px] bg-surface-modal px-4 py-3.5 shadow-sm transition-colors',
        'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
        levelAccentClass(announcement.level),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-[15px] font-semibold leading-5 text-foreground">
            {announcement.title}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <time dateTime={announcement.publishedAt}>{formattedDate}</time>
            {archived && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('announcements.archived')}</span>
              </>
            )}
          </div>
        </div>
        <Badge variant={levelBadgeVariant(announcement.level)} className="shrink-0 px-2 py-0.5 text-[11px]">
          {t(`announcements.level.${announcement.level}`)}
        </Badge>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/80">
        {announcement.content}
      </p>
      {announcement.link && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-2 h-auto px-0 py-0 text-xs font-medium"
          onClick={() => onOpenLink(announcement)}
        >
          {t('announcements.openLink')}
          <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      )}
    </article>
  );
}

function AnnouncementList({
  items,
  emptyTestId,
  emptyLabel,
  archived,
  onOpenLink,
}: {
  items: ClientAnnouncement[];
  emptyTestId: string;
  emptyLabel: string;
  archived?: boolean;
  onOpenLink: (announcement: ClientAnnouncement) => void;
}) {
  if (items.length === 0) {
    return (
      <div
        data-testid={emptyTestId}
        className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-input text-muted-foreground">
          {archived ? <Archive className="h-5 w-5" aria-hidden="true" /> : <Inbox className="h-5 w-5" aria-hidden="true" />}
        </div>
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((announcement) => (
        <AnnouncementItem
          key={getClientAnnouncementKey(announcement)}
          announcement={announcement}
          archived={archived}
          onOpenLink={onOpenLink}
        />
      ))}
    </div>
  );
}

function AnnouncementBellComponent({ collapsed = false, sidebarOffset = 72 }: AnnouncementBellProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AnnouncementTab>('latest');
  const announcements = useAnnouncementsStore((state) => state.announcements);
  const history = useAnnouncementsStore((state) => state.history);
  const readKeys = useAnnouncementsStore((state) => state.readKeys);
  const loading = useAnnouncementsStore((state) => state.loading);
  const fetchConfig = useAnnouncementsStore((state) => state.fetchConfig);
  const markAllAnnouncementsRead = useAnnouncementsStore((state) => state.markAllAnnouncementsRead);
  const markAnnouncementRead = useAnnouncementsStore((state) => state.markAnnouncementRead);

  const archivedAnnouncements = useMemo(
    () => history.filter((item) => !announcements.some(
      (current) => current.id === item.id && current.publishedAt === item.publishedAt,
    )),
    [announcements, history],
  );
  const unreadCount = useMemo(
    () => announcements.filter((item) => !isClientAnnouncementRead(item, readKeys)).length,
    [announcements, readKeys],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) markAllAnnouncementsRead();
  }, [markAllAnnouncementsRead]);

  const handleOpenLink = useCallback(async (announcement: ClientAnnouncement) => {
    markAnnouncementRead(announcement);
    if (announcement.link) await hostApi.shell.openExternal(announcement.link);
  }, [markAnnouncementRead]);

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
            aria-label={t('announcements.title')}
          >
            <Bell className="h-[17px] w-[17px]" />
            {unreadCount > 0 && (
              <span
                data-testid="sidebar-announcements-unread"
                className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-surface-sidebar"
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={collapsed ? 'right' : 'bottom'}>{t('announcements.title')}</TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="left"
          data-testid="announcements-sheet"
          className="w-[min(440px,calc(100vw-72px))] max-w-none border-r p-0 shadow-2xl sm:w-[440px]"
          style={{ left: sidebarOffset }}
        >
          <div className="flex h-full min-h-0 flex-col bg-surface-modal">
            <SheetHeader className="border-b px-5 pb-4 pt-5 text-left">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-[17px] leading-6">{t('announcements.title')}</SheetTitle>
                  <SheetDescription className="mt-1 text-xs leading-5">
                    {t('announcements.description')}
                  </SheetDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid="announcements-refresh"
                        aria-label={t('actions.refresh')}
                        disabled={loading}
                        className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                        onClick={() => void fetchConfig()}
                      >
                        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('actions.refresh')}</TooltipContent>
                  </Tooltip>
                  <SheetClose asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="announcements-close"
                      aria-label={t('actions.close')}
                      className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </SheetClose>
                </div>
              </div>
            </SheetHeader>

            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as AnnouncementTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mx-4 mt-3 grid h-9 shrink-0 grid-cols-2 rounded-lg bg-surface-input p-1">
                <TabsTrigger
                  value="latest"
                  data-testid="announcements-tab-latest"
                  className="h-7 gap-1.5 px-2 text-xs data-[state=active]:shadow-sm"
                >
                  <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('announcements.latest')}
                  <span className="ml-0.5 text-[11px] text-muted-foreground">{announcements.length}</span>
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  data-testid="announcements-tab-history"
                  className="h-7 gap-1.5 px-2 text-xs data-[state=active]:shadow-sm"
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('announcements.history')}
                  <span className="ml-0.5 text-[11px] text-muted-foreground">{archivedAnnouncements.length}</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="latest" className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3">
                <AnnouncementList
                  items={announcements}
                  emptyTestId="announcements-empty"
                  emptyLabel={t('announcements.empty')}
                  onOpenLink={handleOpenLink}
                />
              </TabsContent>
              <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3">
                <AnnouncementList
                  items={archivedAnnouncements}
                  emptyTestId="announcements-history-empty"
                  emptyLabel={t('announcements.historyEmpty')}
                  archived
                  onOpenLink={handleOpenLink}
                />
              </TabsContent>
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export const AnnouncementBell = memo(AnnouncementBellComponent);
