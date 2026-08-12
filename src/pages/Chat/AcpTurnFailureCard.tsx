import { AlertTriangle, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnFailureItem } from '@/lib/acp/timeline-types';
import { Button } from '@/components/ui/button';

function failureCopyKey(code: TurnFailureItem['failure']['code']): string {
  switch (code) {
    case 'INSUFFICIENT_QUOTA': return 'insufficientQuota';
    case 'AUTH_INVALID': return 'authInvalid';
    case 'RATE_LIMIT': return 'rateLimit';
    case 'PERMISSION_DENIED': return 'permissionDenied';
    case 'TIMEOUT': return 'timeout';
    case 'NETWORK': return 'network';
    case 'SERVICE_UNAVAILABLE': return 'serviceUnavailable';
    case 'SESSION_LOCKED': return 'sessionLocked';
    case 'MODEL_UNAVAILABLE': return 'modelUnavailable';
    case 'CONTENT_POLICY': return 'contentPolicy';
    case 'CONVERSATION_INVALID': return 'conversationInvalid';
    case 'IMAGE_TOO_LARGE': return 'imageTooLarge';
    case 'INVALID_REQUEST': return 'invalidRequest';
    case 'CANCELLED': return 'cancelled';
    default: return 'unknown';
  }
}

/** Renders one terminal model failure in the turn where it occurred. */
export function AcpTurnFailureCard({
  item,
  onRecharge,
}: {
  item: TurnFailureItem;
  onRecharge?: () => void;
}) {
  const { t } = useTranslation('chat');
  const key = failureCopyKey(item.failure.code);
  const showRecharge = item.failure.code === 'INSUFFICIENT_QUOTA' && onRecharge;

  return (
    <div
      data-testid="acp-turn-failure"
      data-error-code={item.failure.code}
      className="w-full max-w-2xl border-l-2 border-red-500/60 bg-red-500/5 px-4 py-3 text-red-700 dark:text-red-300"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(`acp.failure.${key}.title`)}</p>
          <p className="mt-1 text-sm text-foreground/75">{t(`acp.failure.${key}.message`)}</p>
          {item.failure.code === 'INVALID_REQUEST' && (
            <p className="mt-2 break-words font-mono text-xs text-foreground/65">
              {item.failure.message}
            </p>
          )}
          {showRecharge && (
            <Button
              type="button"
              size="sm"
              className="mt-3"
              data-testid="acp-turn-failure-recharge"
              onClick={onRecharge}
            >
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              {t('acp.failure.insufficientQuota.action')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
