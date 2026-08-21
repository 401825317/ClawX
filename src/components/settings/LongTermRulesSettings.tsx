import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Globe2, Pencil, Plus, RefreshCw, Trash2, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { LongTermRule, LongTermRuleScope } from '@shared/long-term-rules';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { hostApi } from '@/lib/host-api';
import { resolveEffectiveWorkspace } from '@/lib/workspace-context';
import { useAgentsStore } from '@/stores/agents';
import { useChatStore } from '@/stores/chat';
import { useSettingsStore } from '@/stores/settings';
import { cn } from '@/lib/utils';

type ViewStatus = 'loading' | 'enabled' | 'disabled' | 'error';
type BusyCounts = Map<string, number>;

function updateBusyCount(current: BusyCounts, key: string, delta: 1 | -1): BusyCounts {
  const next = new Map(current);
  const count = (next.get(key) ?? 0) + delta;
  if (count <= 0) next.delete(key); else next.set(key, count);
  return next;
}

export function LongTermRulesSettings() {
  const { t, i18n } = useTranslation('settings');
  const agents = useAgentsStore((state) => state.agents);
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);
  const currentAgentId = useChatStore((state) => state.currentAgentId) || 'main';
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const sessions = useChatStore((state) => state.sessions);
  const chatWorkspacePath = useSettingsStore((state) => state.chatWorkspacePath);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [loadedContextKey, setLoadedContextKey] = useState('');
  const [rules, setRules] = useState<LongTermRule[]>([]);
  const [newContent, setNewContent] = useState('');
  const [newScope, setNewScope] = useState<LongTermRuleScope>('agent');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [busyCounts, setBusyCounts] = useState<BusyCounts>(() => new Map());
  const loadGeneration = useRef(0);
  const activeContext = useRef({ key: '', generation: 0 });
  const mutationSequence = useRef(new Map<string, number>());
  const appliedMutationSequence = useRef(new Map<string, number>());

  const context = useMemo(() => {
    const currentSession = sessions.find((session) => session.key === currentSessionKey) ?? null;
    const effective = resolveEffectiveWorkspace({ session: currentSession, globalWorkspace: chatWorkspacePath });
    const currentAgent = agents.find((agent) => agent.id === currentAgentId);
    return { agentId: currentAgentId, workspaceRoot: currentAgent?.workspace || effective.cwd };
  }, [agents, chatWorkspacePath, currentAgentId, currentSessionKey, sessions]);
  const contextKey = JSON.stringify([context.agentId, context.workspaceRoot]);
  if (activeContext.current.key !== contextKey) {
    activeContext.current = {
      key: contextKey,
      generation: activeContext.current.generation + 1,
    };
  }

  const visibleStatus: ViewStatus = loadedContextKey === contextKey ? status : 'loading';
  const visibleRules = loadedContextKey === contextKey ? rules : [];
  const busyPrefix = `${contextKey}\0`;
  const activeBusyCount = [...busyCounts.entries()].reduce(
    (count, [key, pending]) => count + (key.startsWith(busyPrefix) ? pending : 0),
    0,
  );

  const updatedAtFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.resolvedLanguage]);

  const loadRules = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const contextGeneration = activeContext.current.generation;
    setRules([]);
    setLoadedContextKey(contextKey);
    setStatus('loading');
    setNewContent('');
    setNewScope('agent');
    setEditingId(null);
    setEditingContent('');
    try {
      const result = await hostApi.longTermRules.list(context);
      if (
        generation !== loadGeneration.current
        || activeContext.current.key !== contextKey
        || activeContext.current.generation !== contextGeneration
      ) return;
      setRules(result.rules);
      setStatus(result.status);
    } catch {
      if (
        generation !== loadGeneration.current
        || activeContext.current.key !== contextKey
        || activeContext.current.generation !== contextGeneration
      ) return;
      setRules([]);
      setStatus('error');
    }
  }, [context, contextKey]);

  useEffect(() => {
    if (agents.length === 0) void fetchAgents();
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    void loadRules();
    return () => { loadGeneration.current += 1; };
  }, [loadRules]);

  const setBusy = (operationContextKey: string, key: string, busy: boolean) => {
    const scopedKey = `${operationContextKey}\0${key}`;
    setBusyCounts((current) => updateBusyCount(current, scopedKey, busy ? 1 : -1));
  };

  const beginMutation = (operationContextKey: string, operationKey: string) => {
    const sequence = (mutationSequence.current.get(operationContextKey) ?? 0) + 1;
    mutationSequence.current.set(operationContextKey, sequence);
    setBusy(operationContextKey, operationKey, true);
    return sequence;
  };

  const applyMutation = (
    result: { rules: LongTermRule[]; disabled?: true },
    operationContextKey: string,
    operationContextGeneration: number,
    sequence: number,
  ): boolean => {
    if (
      activeContext.current.key !== operationContextKey
      || activeContext.current.generation !== operationContextGeneration
    ) return false;

    const latestApplied = appliedMutationSequence.current.get(operationContextKey) ?? 0;
    if (sequence < latestApplied) return false;
    appliedMutationSequence.current.set(operationContextKey, sequence);
    setLoadedContextKey(operationContextKey);
    if (result.disabled === true) {
      setRules([]);
      setStatus('disabled');
      return false;
    }
    setRules(result.rules);
    return true;
  };

  const createRule = async () => {
    const submittedContent = newContent.trim();
    if (!submittedContent || visibleStatus !== 'enabled') return;
    const operationContext = { ...context };
    const operationContextKey = contextKey;
    const operationContextGeneration = activeContext.current.generation;
    const sequence = beginMutation(operationContextKey, 'create');
    try {
      const result = await hostApi.longTermRules.create({
        ...operationContext,
        scope: newScope,
        content: submittedContent,
      });
      if (!applyMutation(result, operationContextKey, operationContextGeneration, sequence)) return;
      setNewContent((current) => (current.trim() === submittedContent ? '' : current));
      toast.success(t('longTermRules.created'));
    } catch {
      if (
        activeContext.current.key === operationContextKey
        && activeContext.current.generation === operationContextGeneration
      ) toast.error(t('longTermRules.saveFailed'));
    } finally {
      setBusy(operationContextKey, 'create', false);
    }
  };

  const updateRule = async (rule: LongTermRule, patch: { content?: string; enabled?: boolean }) => {
    if (visibleStatus !== 'enabled') return;
    const operationContext = { ...context };
    const operationContextKey = contextKey;
    const operationContextGeneration = activeContext.current.generation;
    const sequence = beginMutation(operationContextKey, rule.id);
    try {
      const result = await hostApi.longTermRules.update({ ...operationContext, id: rule.id, ...patch });
      if (!applyMutation(result, operationContextKey, operationContextGeneration, sequence)) return;
      setEditingId(null);
      toast.success(t('longTermRules.updated'));
    } catch {
      if (
        activeContext.current.key === operationContextKey
        && activeContext.current.generation === operationContextGeneration
      ) toast.error(t('longTermRules.saveFailed'));
    } finally {
      setBusy(operationContextKey, rule.id, false);
    }
  };

  const deleteRule = async (rule: LongTermRule) => {
    if (visibleStatus !== 'enabled') return;
    const operationContext = { ...context };
    const operationContextKey = contextKey;
    const operationContextGeneration = activeContext.current.generation;
    const sequence = beginMutation(operationContextKey, rule.id);
    try {
      const result = await hostApi.longTermRules.delete({ ...operationContext, id: rule.id });
      if (!applyMutation(result, operationContextKey, operationContextGeneration, sequence)) return;
      toast.success(t('longTermRules.deleted'), result.undoToken ? {
        action: {
          label: t('longTermRules.undo'),
          onClick: () => {
            const undoSequence = beginMutation(operationContextKey, `undo:${result.undoToken!}`);
            void hostApi.longTermRules.undo({ ...operationContext, undoToken: result.undoToken! })
              .then((undoResult) => {
                if (!applyMutation(
                  undoResult,
                  operationContextKey,
                  operationContextGeneration,
                  undoSequence,
                )) return;
                toast.success(t('longTermRules.undone'));
              })
              .catch(() => {
                if (
                  activeContext.current.key === operationContextKey
                  && activeContext.current.generation === operationContextGeneration
                ) toast.error(t('longTermRules.undoFailed'));
              })
              .finally(() => setBusy(operationContextKey, `undo:${result.undoToken!}`, false));
          },
        },
      } : undefined);
    } catch {
      if (
        activeContext.current.key === operationContextKey
        && activeContext.current.generation === operationContextGeneration
      ) toast.error(t('longTermRules.deleteFailed'));
    } finally {
      setBusy(operationContextKey, rule.id, false);
    }
  };

  return (
    <section
      data-testid="settings-long-term-rules"
      data-state={visibleStatus}
      aria-labelledby="long-term-rules-title"
      aria-busy={visibleStatus === 'loading' || activeBusyCount > 0}
    >
      <div className="mb-6">
        <h2 id="long-term-rules-title" className="text-3xl font-serif font-normal tracking-tight text-foreground">
          {t('longTermRules.title')}
        </h2>
        <p className="mt-2 text-meta text-muted-foreground">{t('longTermRules.description')}</p>
      </div>

      {visibleStatus === 'loading' && (
        <p
          data-testid="long-term-rules-loading"
          role="status"
          aria-live="polite"
          className="border-y border-black/10 py-5 text-sm text-muted-foreground dark:border-white/10"
        >
          {t('longTermRules.loading')}
        </p>
      )}
      {visibleStatus === 'disabled' && (
        <div
          data-testid="long-term-rules-disabled"
          role="status"
          className="flex flex-col items-start gap-3 border-y border-black/10 py-5 dark:border-white/10"
        >
          <p className="text-sm font-medium text-foreground">{t('longTermRules.disabledTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('longTermRules.disabledDescription')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadRules()}>
            <RefreshCw className="h-4 w-4" />
            {t('longTermRules.retry')}
          </Button>
        </div>
      )}
      {visibleStatus === 'error' && (
        <div
          data-testid="long-term-rules-error"
          role="alert"
          className="flex flex-col items-start gap-3 border-y border-black/10 py-5 dark:border-white/10"
        >
          <p className="text-sm text-destructive">{t('longTermRules.loadFailed')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadRules()}>
            <RefreshCw className="h-4 w-4" />
            {t('longTermRules.retry')}
          </Button>
        </div>
      )}

      {visibleStatus === 'enabled' && (
        <>
          <div className="space-y-3 border-y border-black/10 py-5 dark:border-white/10">
            <Textarea
              data-testid="long-term-rule-new-content"
              value={newContent}
              onChange={(event) => setNewContent(event.target.value)}
              placeholder={t('longTermRules.placeholder')}
              maxLength={20_000}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex w-fit max-w-full flex-wrap rounded-md bg-black/5 p-1 dark:bg-white/5" role="group" aria-label={t('longTermRules.scope')}>
                {(['agent', 'global'] as const).map((scope) => (
                  <Button
                    key={scope}
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid={`long-term-rule-scope-${scope}`}
                    aria-pressed={newScope === scope}
                    className={cn('rounded-sm', newScope === scope && 'bg-background shadow-sm')}
                    onClick={() => setNewScope(scope)}
                  >
                    {scope === 'global' ? <Globe2 className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
                    {t(`longTermRules.scope${scope === 'global' ? 'Global' : 'Agent'}`)}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                data-testid="long-term-rule-create"
                disabled={!newContent.trim() || (busyCounts.get(`${contextKey}\0create`) ?? 0) > 0}
                onClick={() => void createRule()}
              >
                <Plus className="h-4 w-4" />
                {t('longTermRules.add')}
              </Button>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {visibleRules.length === 0 && (
              <p data-testid="long-term-rules-empty" className="py-4 text-sm text-muted-foreground">
                {t('longTermRules.empty')}
              </p>
            )}
            {visibleRules.map((rule) => {
              const editing = editingId === rule.id;
              const busy = (busyCounts.get(`${contextKey}\0${rule.id}`) ?? 0) > 0;
              return (
                <article key={rule.id} data-testid={`long-term-rule-${rule.id}`} className="min-w-0 rounded-lg border border-black/10 p-4 dark:border-white/10">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div
                        data-testid={`long-term-rule-metadata-${rule.id}`}
                        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-muted-foreground"
                      >
                        {rule.scope === 'global' ? <Globe2 className="h-4 w-4 shrink-0" /> : <UserRound className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0 break-words">{t(`longTermRules.scope${rule.scope === 'global' ? 'Global' : 'Agent'}`)}</span>
                        <span className="min-w-0 break-words">{t('longTermRules.version', { version: rule.version })}</span>
                        <span className="min-w-0 basis-full break-words sm:basis-auto">{t('longTermRules.updatedAt', { date: updatedAtFormatter.format(new Date(rule.updatedAt)) })}</span>
                      </div>
                      {editing ? (
                        <Textarea className="mt-3" data-testid={`long-term-rule-edit-${rule.id}`} value={editingContent} onChange={(event) => setEditingContent(event.target.value)} maxLength={20_000} />
                      ) : (
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground">{rule.content}</p>
                      )}
                    </div>
                    <Switch className="shrink-0 self-end sm:self-start" checked={rule.enabled} disabled={busy} aria-label={t('longTermRules.enabled')} onCheckedChange={(enabled) => void updateRule(rule, { enabled })} />
                  </div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {editing ? (
                      <>
                        <Button type="button" size="sm" variant="outline" aria-label={t('longTermRules.cancel')} onClick={() => setEditingId(null)}><X className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" aria-label={t('longTermRules.save')} disabled={!editingContent.trim() || busy} onClick={() => void updateRule(rule, { content: editingContent })}><Check className="h-4 w-4" /></Button>
                      </>
                    ) : (
                      <>
                        <Button type="button" size="sm" variant="outline" aria-label={t('longTermRules.edit')} disabled={busy} onClick={() => { setEditingId(rule.id); setEditingContent(rule.content); }}><Pencil className="h-4 w-4" /></Button>
                        <Button type="button" size="sm" variant="outline" aria-label={t('longTermRules.delete')} disabled={busy} onClick={() => void deleteRule(rule)}><Trash2 className="h-4 w-4" /></Button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
