import { useMemo } from 'react';
import { Activity, Code2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSettingsStore } from '@/stores/settings';
import { useConversationStore } from '@/stores/conversation/store';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import { deriveConversationExecutionSteps } from './execution-details-projection';
import type {
  ConversationIngressDiagnostics,
  ConversationMergeEvidence,
  ConversationTurn,
} from '@/stores/conversation/types';
import { isActiveTurnStatus } from '@/stores/conversation/types';
import { getConversationPerformanceSnapshot } from '@/stores/conversation/metrics';

interface ExecutionDetailsSheetProps {
  turnId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EMPTY_EVENTS: never[] = [];
const EMPTY_INGRESS_DIAGNOSTICS: ConversationIngressDiagnostics = {
  duplicateCount: 0,
  staleSequenceCount: 0,
  quarantineCount: 0,
  assignments: [],
};

function mergeDiagnostics(turn: ConversationTurn | undefined): ConversationMergeEvidence[] {
  if (!turn) return [];
  const evidence = [
    turn.evidence.runTerminalMerge,
    ...Object.values(turn.toolMergeByCallId).flatMap((state) => Object.values(state.fields)),
    ...Object.values(turn.approvalMergeById).flatMap((state) => Object.values(state.fields)),
    ...Object.values(turn.artifactMergeByEntity).flatMap((state) => Object.values(state.fields)),
    ...Object.values(turn.verificationMergeByEntity).flatMap((state) => Object.values(state.fields)),
    ...Object.values(turn.finalMerge.fields),
  ].filter((entry): entry is ConversationMergeEvidence => Boolean(entry));
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = `${entry.domain}:${entry.eventId}:${entry.source}:${entry.authority}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function itemMutationDiagnostics(turn: ConversationTurn | undefined) {
  return turn?.items.flatMap((item) => item.sourceEventIds.map((eventId) => ({
    eventId,
    itemKind: item.kind,
  }))).slice(-32) ?? [];
}

function historyCorrectionDiagnostics(turn: ConversationTurn | undefined) {
  if (!turn) return [];
  const corrections: Array<{ domain: string; field: string; eventId: string }> = [];
  const append = (domain: string, fields: Record<string, ConversationMergeEvidence>) => {
    Object.entries(fields).forEach(([field, evidence]) => {
      if (evidence.source === 'history') corrections.push({ domain, field, eventId: evidence.eventId });
    });
  };
  if (turn.evidence.runTerminalMerge?.source === 'history') {
    corrections.push({
      domain: 'run',
      field: 'status',
      eventId: turn.evidence.runTerminalMerge.eventId,
    });
  }
  Object.entries(turn.toolMergeByCallId).forEach(([id, state]) => append(`tool:${id}`, state.fields));
  Object.entries(turn.approvalMergeById).forEach(([id, state]) => append(`approval:${id}`, state.fields));
  Object.entries(turn.artifactMergeByEntity).forEach(([id, state]) => append(`artifact:${id}`, state.fields));
  Object.entries(turn.verificationMergeByEntity).forEach(([id, state]) => append(`verification:${id}`, state.fields));
  append('final', turn.finalMerge.fields);
  return corrections.slice(-32);
}

function settlementBlockers(turn: ConversationTurn | undefined) {
  if (!turn) return [];
  if (!isActiveTurnStatus(turn.status)) {
    return [{ key: 'settled', count: 0 }];
  }
  const blockers: Array<{ key: string; count: number }> = [];
  if (turn.evidence.pendingToolCount > 0) blockers.push({ key: 'pendingTools', count: turn.evidence.pendingToolCount });
  if (turn.evidence.pendingTaskCount > 0) blockers.push({ key: 'pendingTasks', count: turn.evidence.pendingTaskCount });
  if (turn.evidence.pendingApprovalCount > 0) blockers.push({ key: 'pendingApprovals', count: turn.evidence.pendingApprovalCount });
  if (!turn.evidence.runTerminal && !turn.evidence.backendIdle) blockers.push({ key: 'awaitingLifecycle', count: 0 });
  if (!turn.evidence.finalMessagePresent && !turn.items.some((item) => item.kind === 'artifact-group')) {
    blockers.push({ key: 'missingFinal', count: 0 });
  }
  if (!turn.evidence.requiredArtifactsSatisfied) blockers.push({ key: 'requiredArtifacts', count: 0 });
  if (turn.evidence.blockingVerificationFailed) blockers.push({ key: 'blockingVerification', count: 0 });
  if (
    turn.evidence.runTerminal
    && turn.evidence.finalMessagePresent
    && turn.evidence.runTerminalAuthority !== 'authoritative'
    && !turn.evidence.backendIdle
    && !turn.evidence.historyCheckpointed
  ) {
    blockers.push({ key: 'historyCheckpoint', count: 0 });
  }
  return blockers.length > 0 ? blockers : [{ key: 'activeWork', count: 0 }];
}

function unavailableArtifactDiagnostics(turn: ConversationTurn | undefined) {
  return turn?.items.flatMap((item) => item.kind === 'artifact-group'
    ? item.artifacts.filter((artifact) => (
        artifact.availability === 'unavailable'
        || artifact.availability === 'error'
        || Boolean(artifact.error)
      )).map((artifact) => ({
        kind: artifact.kind || 'artifact',
        availability: artifact.availability ?? 'error',
        hasError: Boolean(artifact.error),
      }))
    : []) ?? [];
}

export function ExecutionDetailsSheet({ turnId, open, onOpenChange }: ExecutionDetailsSheetProps) {
  const { t } = useTranslation('chat');
  const diagnostic = (key: string): string => t(`timeline.diagnostics.${key}`);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const turn = useConversationStore((state) => open ? state.turnsById[turnId] : undefined);
  const events = useConversationStore((state) => (
    open ? state.eventsByTurnId[turnId] ?? EMPTY_EVENTS : EMPTY_EVENTS
  ));
  const retentionCheckpoint = useConversationStore((state) => (
    open ? state.eventRetentionByTurnId[turnId] : undefined
  ));
  const quarantine = useConversationStore((state) => (
    open && turn ? state.quarantineBySession[turn.sessionKey] : undefined
  ));
  const ingressDiagnostics = useConversationStore((state) => (
    open && turn
      ? state.ingressDiagnosticsBySession[turn.sessionKey] ?? EMPTY_INGRESS_DIAGNOSTICS
      : EMPTY_INGRESS_DIAGNOSTICS
  ));
  const steps = useMemo(
    () => deriveConversationExecutionSteps(turn, {
      approval: t('timeline.approval'),
      artifact: t('timeline.artifact'),
      plan: t('timeline.plan'),
      verification: t('timeline.verification'),
      taskFlow: t('timeline.taskFlow'),
      toolInput: t('timeline.toolInput'),
      toolOutput: t('timeline.toolOutput'),
    }, events),
    [events, t, turn],
  );
  const active = isActiveTurnStatus(turn?.status);
  const mergeEvidence = useMemo(() => mergeDiagnostics(turn), [turn]);
  const itemMutations = useMemo(() => itemMutationDiagnostics(turn), [turn]);
  const historyCorrections = useMemo(() => historyCorrectionDiagnostics(turn), [turn]);
  const blockers = useMemo(() => settlementBlockers(turn), [turn]);
  const unavailableArtifacts = useMemo(() => unavailableArtifactDiagnostics(turn), [turn]);
  const performanceMetrics = open ? getConversationPerformanceSnapshot() : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[min(92vw,760px)] max-w-none flex-col overflow-hidden p-0 sm:max-w-none">
        <SheetHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" aria-hidden="true" />
            {t('timeline.executionDetails')}
          </SheetTitle>
          <SheetDescription>{t('timeline.executionDetailsDescription')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {steps.length > 0 ? (
            <ExecutionGraphCard
              agentLabel={t('timeline.agentRun')}
              steps={steps}
              active={active}
              detailsEnabled
              expanded
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('timeline.noExecutionGraph')}</p>
          )}
          {devModeUnlocked && (
            <section className="space-y-2" data-testid="timeline-event-diagnostics">
              <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground/75">
                <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                {t('timeline.rawEvents')}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2" data-testid="timeline-reducer-diagnostics">
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{t('timeline.diagnostics.retention')}</div>
                  <div>{diagnostic('retained')}: {events.length}</div>
                  <div>{diagnostic('total')}: {retentionCheckpoint?.totalEventCount ?? events.length}</div>
                  <div>{diagnostic('dropped')}: {retentionCheckpoint?.droppedEventCount ?? 0}</div>
                  <div>{diagnostic('quarantined')}: {quarantine?.records.length ?? 0}</div>
                  <div>{diagnostic('quarantineDropped')}: {quarantine?.droppedCount ?? 0}</div>
                  {retentionCheckpoint && <div className="truncate">{diagnostic('lastEventId')}: {retentionCheckpoint.lastEventId}</div>}
                  {quarantine?.records.slice(-3).map((record) => (
                    <div key={record.eventId} className="truncate">{record.type} · {record.runId}</div>
                  ))}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{t('timeline.diagnostics.watermarks')}</div>
                  {Object.entries(turn?.sequenceWatermarks ?? {}).length > 0
                    ? Object.entries(turn?.sequenceWatermarks ?? {}).map(([stream, seq]) => (
                        <div key={stream} className="flex gap-2">
                          <span className="min-w-0 flex-1 truncate">{stream}</span>
                          <span className="shrink-0">{seq}</span>
                        </div>
                      ))
                    : <div>{t('timeline.diagnostics.none')}</div>}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{t('timeline.diagnostics.mergeEvidence')}</div>
                  <div>{diagnostic('records')}: {mergeEvidence.length}</div>
                  {mergeEvidence.slice(-8).map((entry) => (
                    <div key={`${entry.domain}:${entry.eventId}`} className="truncate">
                      {entry.domain} · {entry.source} · {entry.authority}{entry.seq == null ? '' : ` · ${diagnostic('sequence')} ${entry.seq}`}
                    </div>
                  ))}
                </div>
                <div
                  className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground"
                  data-testid="timeline-assignment-diagnostics"
                >
                  <div className="font-semibold text-foreground/70">{diagnostic('assignments')}</div>
                  <div>{diagnostic('records')}: {ingressDiagnostics.assignments.length}</div>
                  <div>{diagnostic('duplicates')}: {ingressDiagnostics.duplicateCount}</div>
                  <div>{diagnostic('staleSequences')}: {ingressDiagnostics.staleSequenceCount}</div>
                  <div>{diagnostic('quarantined')}: {ingressDiagnostics.quarantineCount}</div>
                  {ingressDiagnostics.assignments.length > 0
                    ? ingressDiagnostics.assignments.map((entry, index) => (
                        <div key={`${entry.eventId}:${entry.basis}:${index}`} className="truncate">
                          {entry.type} · {entry.basis} · {entry.confidence}
                        </div>
                      ))
                    : <div>{diagnostic('none')}</div>}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{diagnostic('itemMutations')}</div>
                  {itemMutations.length > 0
                    ? itemMutations.map((entry, index) => (
                        <div key={`${entry.eventId}:${entry.itemKind}:${index}`} className="truncate">
                          {entry.eventId} · {entry.itemKind}
                        </div>
                      ))
                    : <div>{diagnostic('none')}</div>}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{diagnostic('settlement')}</div>
                  {blockers.map((blocker) => (
                    <div key={blocker.key}>
                      {diagnostic(blocker.key)}{blocker.count > 0 ? `: ${blocker.count}` : ''}
                    </div>
                  ))}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{diagnostic('historyCorrections')}</div>
                  {historyCorrections.length > 0
                    ? historyCorrections.map((entry, index) => (
                        <div key={`${entry.eventId}:${entry.domain}:${entry.field}:${index}`} className="truncate">
                          {entry.domain} · {entry.field} · {entry.eventId}
                        </div>
                      ))
                    : <div>{diagnostic('none')}</div>}
                </div>
                <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground">
                  <div className="font-semibold text-foreground/70">{diagnostic('artifactAvailability')}</div>
                  {unavailableArtifacts.length > 0
                    ? unavailableArtifacts.map((artifact, index) => (
                        <div key={`${artifact.kind}:${artifact.availability}:${index}`} className="truncate">
                          {artifact.kind} · {artifact.availability} · {diagnostic(artifact.hasError ? 'errorPresent' : 'noError')}
                        </div>
                      ))
                    : <div>{diagnostic('none')}</div>}
                </div>
                {performanceMetrics && (
                  <div className="rounded-md bg-surface-input px-3 py-2 text-2xs leading-5 text-muted-foreground sm:col-span-2">
                    <div className="font-semibold text-foreground/70">{t('timeline.diagnostics.performance')}</div>
                    <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                      <span>{diagnostic('ingress')} {performanceMetrics.ingressEvents}</span>
                      <span>{diagnostic('commits')} {performanceMetrics.storeCommits}</span>
                      <span>{diagnostic('renders')} {performanceMetrics.itemRenders}</span>
                      <span>{diagnostic('mounted')} {performanceMetrics.mountedRows}/{performanceMetrics.maxMountedRows}</span>
                      <span>{diagnostic('adapter')} {performanceMetrics.adapter.maxMs.toFixed(1)}ms {diagnostic('maximum')}</span>
                      <span>{diagnostic('reducer')} {performanceMetrics.reducer.maxMs.toFixed(1)}ms {diagnostic('maximum')}</span>
                      <span>{diagnostic('projection')} {performanceMetrics.projection.maxMs.toFixed(1)}ms {diagnostic('maximum')}</span>
                      <span>{diagnostic('replay')} {performanceMetrics.historyReplay.lastMs.toFixed(1)}ms</span>
                      <span>{diagnostic('fps')} {performanceMetrics.averageFps.toFixed(1)}</span>
                      <span>{diagnostic('slowFrames')} {performanceMetrics.slowFrames}</span>
                      <span>{diagnostic('longTasks')} {performanceMetrics.longTasks.count}</span>
                      <span>{diagnostic('scrollCorrections')} {performanceMetrics.scrollCorrections}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                {events.map((event) => (
                  <div key={event.eventId} className="rounded-md bg-surface-input px-3 py-2 font-mono text-2xs leading-5 text-muted-foreground">
                    <div className="flex flex-wrap gap-x-3">
                      <span>{event.type}</span>
                      <span>{event.source}</span>
                      <span>{event.authority}</span>
                      <span>{event.timelineVisibility ?? diagnostic('defaultVisibility')}</span>
                      <span>{diagnostic('sequence')} {event.seq ?? '-'}</span>
                    </div>
                    <div className="truncate opacity-70">{event.eventId}</div>
                    <div className="flex flex-wrap gap-x-3 opacity-70">
                      <span>{diagnostic('occurredAt')} {event.occurredAt}</span>
                      <span>{diagnostic('receivedAt')} {event.receivedAt}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 opacity-70">
                      <span>{diagnostic('session')} {event.sessionKey}</span>
                      {event.turnId && <span>{diagnostic('turn')} {event.turnId}</span>}
                      {event.rootRunId && <span>{diagnostic('rootRun')} {event.rootRunId}</span>}
                      {event.runId && <span>{diagnostic('run')} {event.runId}</span>}
                      {event.taskId && <span>{diagnostic('task')} {event.taskId}</span>}
                      {event.parentTaskId && <span>{diagnostic('parentTask')} {event.parentTaskId}</span>}
                      {event.toolCallId && <span>{diagnostic('tool')} {event.toolCallId}</span>}
                      {event.messageId && <span>{diagnostic('message')} {event.messageId}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
