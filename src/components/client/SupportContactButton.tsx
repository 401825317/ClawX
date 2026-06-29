import { memo, useCallback, useState } from 'react';
import { Headphones, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
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
import { cn } from '@/lib/utils';
import { useClientConfigStore } from '@/stores/client-config';

interface SupportContactButtonProps {
  collapsed?: boolean;
  sidebarOffset?: number;
}

function SupportContactButtonComponent(props: SupportContactButtonProps) {
  const { t } = useTranslation(['common']);
  const [open, setOpen] = useState(false);
  const support = useClientConfigStore((state) => state.support);
  const fetchConfig = useClientConfigStore((state) => state.fetchConfig);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      void fetchConfig();
    }
  }, [fetchConfig]);

  if (!support) {
    return null;
  }

  const copyWechatId = async (wechatId: string) => {
    if (!wechatId) return;
    try {
      await navigator.clipboard.writeText(wechatId);
      toast.success(t('common:support.copied'));
    } catch {
      toast.error(t('common:support.copyFailed'));
    }
  };

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
              'hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80',
              props.collapsed ? 'justify-center px-0' : 'justify-start',
            )}
            onClick={() => handleOpenChange(true)}
          >
            <div className="flex shrink-0 items-center justify-center text-current [&_svg]:size-4">
              <Headphones className="h-4 w-4" strokeWidth={2} />
            </div>
            {!props.collapsed && (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                {t('common:support.nav')}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        {props.collapsed && (
          <TooltipContent side="right">{t('common:support.nav')}</TooltipContent>
        )}
      </Tooltip>

      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="left"
          className="w-[360px] max-w-[calc(100vw-88px)] border-r p-0"
          style={{ left: props.sidebarOffset ?? 72 }}
        >
          <div className="flex h-full min-h-0 flex-col">
            <SheetHeader className="border-b px-5 py-4 text-left">
              <SheetTitle>{support.title || t('common:support.title')}</SheetTitle>
              <SheetDescription>
                {support.description || t('common:support.description')}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-3">
                {support.contacts?.map((contact) => (
                  <div
                    key={contact.id}
                    className="rounded-lg border bg-card p-4 text-center"
                  >
                    <div className="text-sm font-medium text-foreground">
                      {contact.label}
                    </div>
                    {contact.description && (
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {contact.description}
                      </p>
                    )}
                    <div className="mt-3 inline-flex rounded-xl border bg-white p-3 shadow-sm">
                      <img
                        src={contact.qrCodeUrl}
                        alt={t('common:support.contactQrAlt', { name: contact.label })}
                        className="h-48 w-48 object-contain"
                      />
                    </div>
                    {contact.workHours && (
                      <p className="mt-3 text-sm text-muted-foreground">
                        {contact.workHours}
                      </p>
                    )}
                    {contact.wechatId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => void copyWechatId(contact.wechatId || '')}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        {t('common:support.copyWechat', { id: contact.wechatId })}
                      </Button>
                    )}
                    {contact.extraNote && (
                      <p className="mt-3 text-xs leading-5 text-muted-foreground">
                        {contact.extraNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export const SupportContactButton = memo(SupportContactButtonComponent);
