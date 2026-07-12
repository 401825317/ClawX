import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface ReasoningPanelProps {
  text: string;
  live?: boolean;
}

export function ReasoningPanel({ text, live = false }: ReasoningPanelProps) {
  const { t } = useTranslation('chat');
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? live;

  if (!text.trim()) return null;

  const title = live
    ? t('reasoning.live', { defaultValue: '正在思考' })
    : t('reasoning.title', { defaultValue: '思考过程' });

  return (
    <section
      className={cn(
        'relative ml-1 border-l pl-4',
        live ? 'border-foreground/25' : 'border-border/70',
      )}
      aria-label={title}
      data-testid="reasoning-panel"
      data-live={live ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => setExpandedOverride((value) => !(value ?? live))}
        className="group flex min-h-7 max-w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={expanded}
        aria-label={expanded
          ? t('reasoning.hide', { defaultValue: '收起思考过程' })
          : t('reasoning.show', { defaultValue: '展开思考过程' })}
      >
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          {live && (
            <span className="absolute inset-0 animate-pulse rounded-full bg-foreground/10" />
          )}
          <Brain className="relative h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="truncate font-medium">{title}</span>
        {live && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />}
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div className="max-w-3xl pb-1 pt-1.5 text-xs leading-5 text-muted-foreground">
          <div className="whitespace-pre-wrap break-words">{text}</div>
        </div>
      )}
    </section>
  );
}
