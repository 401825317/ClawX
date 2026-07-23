import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Headphones } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UCLAW_SUPPORT_REFRESH_INTERVAL_MS } from '@shared/junfeiai-endpoints';
import type { SupportContactConfig } from '@/lib/host-api';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
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

type SupportContactButtonProps = {
  collapsed?: boolean;
  sidebarOffset?: number;
};

function SupportContactButtonComponent(props: SupportContactButtonProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState<SupportContactConfig | null>(null);
  const requestVersionRef = useRef(0);

  const refreshConfig = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    try {
      const nextSupport = await hostApi.support.config();
      if (requestVersion === requestVersionRef.current) {
        setSupport(nextSupport);
      }
    } catch {
      // Keep the last valid config and avoid interrupting unrelated workflows.
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refreshConfig(), 0);
    const interval = window.setInterval(refreshConfig, UCLAW_SUPPORT_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshConfig();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      requestVersionRef.current += 1;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshConfig]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) void refreshConfig();
  }, [refreshConfig]);

  const copyWechatId = async (wechatId: string) => {
    try {
      await navigator.clipboard.writeText(wechatId);
      toast.success(t('support.copied'));
    } catch {
      toast.error(t('support.copyFailed'));
    }
  };

  if (!support) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            data-testid="sidebar-support-contact"
            variant="ghost"
            className={cn(
              'sidebar-nav-text flex h-auto w-full items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors',
              'text-foreground/80 hover:bg-black/5 dark:hover:bg-white/5',
              props.collapsed ? 'justify-center px-0' : 'justify-start',
            )}
            onClick={() => handleOpenChange(true)}
            aria-label={t('support.nav')}
          >
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <Headphones className="h-4 w-4" strokeWidth={2} />
            </div>
            {!props.collapsed && (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                {t('support.nav')}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        {props.collapsed && (
          <TooltipContent side="right">{t('support.nav')}</TooltipContent>
        )}
      </Tooltip>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="left"
          className="w-[360px] max-w-[calc(100vw-88px)] border-r bg-surface-modal p-0 sm:max-w-[360px]"
          style={{ left: props.sidebarOffset ?? 72 }}
        >
          <div className="flex h-full min-h-0 flex-col">
            <SheetHeader className="border-b px-5 py-4 text-left">
              <SheetTitle className="break-words">
                {support.title || t('support.title')}
              </SheetTitle>
              <SheetDescription className="break-words">
                {support.description || t('support.description')}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                {support.contacts.map((contact, index) => {
                  const label = contact.label || t('support.contactFallback', { index: index + 1 });
                  const wechatId = contact.wechatId;
                  return (
                    <section
                      key={`${contact.id}:${index}`}
                      className="rounded-lg border bg-surface-modal p-4 text-center"
                    >
                      <h3 className="break-words text-sm font-medium text-foreground">{label}</h3>
                      {contact.description && (
                        <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                          {contact.description}
                        </p>
                      )}
                      <div className="mt-3 inline-flex rounded-md border bg-white p-3 shadow-sm">
                        <img
                          src={contact.qrCodeUrl}
                          alt={t('support.contactQrAlt', { name: label })}
                          className="h-48 w-48 object-contain"
                          loading="lazy"
                          draggable={false}
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      {contact.workHours && (
                        <p className="mt-3 break-words text-sm text-muted-foreground">
                          {contact.workHours}
                        </p>
                      )}
                      {wechatId && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-3 h-auto max-w-full whitespace-normal py-2"
                          onClick={() => void copyWechatId(wechatId)}
                        >
                          <Copy className="mr-2 h-4 w-4 shrink-0" />
                          <span className="min-w-0 break-all">
                            {t('support.copyWechat', { id: wechatId })}
                          </span>
                        </Button>
                      )}
                      {contact.extraNote && (
                        <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">
                          {contact.extraNote}
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export const SupportContactButton = memo(SupportContactButtonComponent);
