import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BillingOrderHistory } from '@shared/billing';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  paymentStatusTone,
} from './recharge-utils';

type OrderHistoryDialogProps = {
  open: boolean;
  history: BillingOrderHistory;
  loading: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onPageChange: (page: number) => void;
};

export function OrderHistoryDialog({
  open,
  history,
  loading,
  error,
  onOpenChange,
  onPageChange,
}: OrderHistoryDialogProps) {
  const { t, i18n } = useTranslation('recharge');
  const totalPages = Math.max(1, Math.ceil(history.total / Math.max(1, history.pageSize)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-lg border border-black/10 bg-surface-modal p-0 shadow-2xl dark:border-white/10">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 px-6 py-5 dark:border-white/10">
          <div>
            <DialogTitle className="font-serif text-xl font-normal tracking-tight text-foreground">
              {t('orders.title')}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {t('orders.description')}
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t('checkout.close')}
            title={t('checkout.close')}
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="min-h-72 max-h-[68vh] overflow-auto">
          {loading ? (
            <div className="flex min-h-72 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              {t('loading')}
            </div>
          ) : error ? (
            <div className="flex min-h-72 items-center justify-center px-8 text-center text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          ) : history.items.length === 0 ? (
            <div className="flex min-h-72 items-center justify-center text-sm text-muted-foreground">
              {t('orders.empty')}
            </div>
          ) : (
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface-modal text-xs text-muted-foreground">
                <tr className="border-b border-black/10 dark:border-white/10">
                  <th className="px-6 py-3 font-medium">{t('orders.date')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.amount')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.quota')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.method')}</th>
                  <th className="px-6 py-3 text-right font-medium">{t('orders.status')}</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((order) => (
                  <tr
                    key={order.tradeNo}
                    className="border-b border-black/5 text-foreground last:border-b-0 dark:border-white/5"
                  >
                    <td className="whitespace-nowrap px-6 py-4 text-muted-foreground">
                      {formatDateTime(order.createdAt, i18n.language)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 font-medium">
                      {formatCurrency(order.amountYuan, i18n.language)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4">
                      {formatNumber(order.creditQuota, i18n.language, 0)}
                    </td>
                    <td className="max-w-44 truncate px-4 py-4 text-muted-foreground">
                      {order.paymentMethod || order.paymentProvider || '-'}
                    </td>
                    <td className={cn('whitespace-nowrap px-6 py-4 text-right font-medium', paymentStatusTone(order.status))}>
                      {t(`status.${order.status}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-black/10 px-6 py-4 dark:border-white/10">
          <span className="text-sm text-muted-foreground">
            {t('orders.page', { page: history.page, total: totalPages })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || history.page <= 1}
              onClick={() => onPageChange(history.page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
              {t('orders.previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || history.page >= totalPages}
              onClick={() => onPageChange(history.page + 1)}
            >
              {t('orders.next')}
              <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
