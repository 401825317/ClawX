import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowDownToLine, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import type { GeneratedFile } from '@/lib/generated-files';
import type { AttachedFileMeta } from '@/stores/chat';
import { useConversationStore, type ConversationStore } from '@/stores/conversation/store';
import {
  getConversationPerformanceSnapshot,
  recordTimelineMountedRows,
  recordTimelineScrollCorrection,
  resetConversationPerformanceMetrics,
  startConversationPerformanceObservers,
} from '@/stores/conversation/metrics';
import type { ConversationPerformanceSnapshot } from '@/stores/conversation/metrics';
import { isActiveTurnStatus, type TimelineItemKind } from '@/stores/conversation/types';
import { ExecutionDetailsSheet } from './ExecutionDetailsSheet';
import { TimelineItemRow } from './TimelineItemRow';

interface ConversationTimelineProps {
  sessionKey: string;
  assistantAvatarSrc?: string | null;
  hasMoreHistory: boolean;
  loadingMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  onOpenFile?: (file: AttachedFileMeta) => void;
  onUseImageAsReference?: (file: AttachedFileMeta) => void;
  onOpenGeneratedFile?: (file: GeneratedFile) => void;
  retryableTurnId?: string | null;
  onRetryTurn?: (turnId: string) => Promise<void> | void;
  emptyState?: React.ReactNode;
}

interface ConversationPerformanceTestApi {
  reset: () => void;
  snapshot: () => ConversationPerformanceSnapshot;
}

declare global {
  interface Window {
    __clawxTimelinePerformance?: ConversationPerformanceTestApi;
  }
}

export interface ConversationTimelineHandle {
  scrollToTurn: (turnId: string) => void;
  scrollToLatest: () => void;
}

const TimelineScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function TimelineScroller(props, ref) {
    const { style, ...rest } = props;
    return (
      <div
        {...rest}
        ref={ref}
        style={{ ...style, overflowAnchor: 'none' }}
        data-testid="chat-scroll-container"
      />
    );
  },
);

const FIRST_ITEM_INDEX_BASE = 1_000_000;
const BOTTOM_THRESHOLD_PX = 12;
const DYNAMIC_LAYOUT_ANCHOR_RESTORE_FRAMES = 8;
const FOLLOW_SCROLL_SETTLE_FRAMES = 4;
const USER_SCROLL_INTENT_WINDOW_MS = 1_500;
const PROGRAMMATIC_SCROLL_GUARD_MS = 350;
const SCROLLBAR_HIT_WIDTH_PX = 24;

type ScrollDirection = 'up' | 'down';

interface UserScrollIntent {
  direction: ScrollDirection;
  expiresAt: number;
  persistent: boolean;
}

interface TimelineWindow {
  sessionKey: string;
  rowKeys: string[];
  firstItemIndex: number;
}

type TimelineRow = {
  key: string;
  kind: 'item';
  turnId: string;
  itemId: string;
  executionDetailsEntry: boolean;
  firstInTurn: boolean;
  lastInTurn: boolean;
} | {
  key: string;
  kind: 'status';
  turnId: string;
  firstInTurn: boolean;
  lastInTurn: boolean;
};

interface VisibleTimelineAnchor {
  rowId: string;
  offsetTop: number;
}

const EXECUTION_DETAILS_ITEM_KINDS = new Set<TimelineItemKind>([
  'plan',
  'tool-group',
  'subtask',
  'approval',
  'artifact-group',
  'verification-summary',
  'error',
]);

function timelineItemRowKey(turnId: string, itemId: string, executionDetailsEntry: boolean): string {
  return JSON.stringify(executionDetailsEntry
    ? ['item', turnId, itemId, 'execution-details']
    : ['item', turnId, itemId]);
}

function timelineStatusRowKey(turnId: string): string {
  return JSON.stringify(['status', turnId]);
}

function createTimelineRowKeySelector(sessionKey: string): (state: ConversationStore) => string[] {
  let previousTurnIds: string[] = [];
  let previousSegments: string[][] = [];
  let previousRowKeys: string[] = [];
  const segmentCache = new Map<string, {
    active: boolean;
    itemIndex: Record<string, number>;
    rowKeys: string[];
  }>();

  return (state) => {
    const turnIds = state.turnOrderBySession[sessionKey] ?? [];
    let changed = turnIds.length !== previousTurnIds.length;
    const nextSegments = turnIds.map((turnId, index) => {
      if (previousTurnIds[index] !== turnId) changed = true;
      const turn = state.turnsById[turnId];
      if (!turn) return [];
      const active = isActiveTurnStatus(turn.status);
      const cached = segmentCache.get(turnId);
      const executionDetailsItemId = turn.items.find((item) => EXECUTION_DETAILS_ITEM_KINDS.has(item.kind))?.id;
      const segment = cached?.itemIndex === turn.itemIndex && cached.active === active
        ? cached.rowKeys
        : [
            ...turn.items.map((item) => timelineItemRowKey(turnId, item.id, item.id === executionDetailsItemId)),
            ...(active ? [timelineStatusRowKey(turnId)] : []),
          ];
      if (segment !== previousSegments[index]) changed = true;
      if (segment !== cached?.rowKeys) {
        segmentCache.set(turnId, { active, itemIndex: turn.itemIndex, rowKeys: segment });
      }
      return segment;
    });

    if (!changed) return previousRowKeys;
    previousTurnIds = turnIds;
    previousSegments = nextSegments;
    previousRowKeys = nextSegments.flat();
    return previousRowKeys;
  };
}

function decodeTimelineRows(rowKeys: string[]): TimelineRow[] {
  const rows = rowKeys.map((key) => {
    const [kind, turnId, itemId, marker] = JSON.parse(key) as ['item' | 'status', string, string?, string?];
    return kind === 'item'
      ? { key, kind, turnId, itemId: itemId as string, executionDetailsEntry: marker === 'execution-details' }
      : { key, kind, turnId };
  });

  return rows.map((row, index) => ({
    ...row,
    firstInTurn: rows[index - 1]?.turnId !== row.turnId,
    lastInTurn: rows[index + 1]?.turnId !== row.turnId,
  }));
}

function reconcileTimelineWindow(
  previous: TimelineWindow,
  sessionKey: string,
  rowKeys: string[],
): TimelineWindow {
  if (previous.sessionKey !== sessionKey || previous.rowKeys.length === 0 || rowKeys.length === 0) {
    return { sessionKey, rowKeys, firstItemIndex: FIRST_ITEM_INDEX_BASE };
  }

  const nextIndexByRowKey = new Map(rowKeys.map((rowKey, index) => [rowKey, index]));
  for (let previousIndex = 0; previousIndex < previous.rowKeys.length; previousIndex += 1) {
    const nextIndex = nextIndexByRowKey.get(previous.rowKeys[previousIndex]);
    if (nextIndex == null) continue;

    // Keep the first shared row on the same Virtuoso absolute index. This is
    // the inverse-list contract that lets Virtuoso compensate a prepend by the
    // exact measured height of the newly inserted timeline items.
    return {
      sessionKey,
      rowKeys,
      firstItemIndex: Math.max(0, previous.firstItemIndex + previousIndex - nextIndex),
    };
  }

  return { sessionKey, rowKeys, firstItemIndex: FIRST_ITEM_INDEX_BASE };
}

function timelineRowPadding(firstInTurn: boolean, lastInTurn: boolean): string {
  if (firstInTurn && lastInTurn) return 'py-3';
  if (firstInTurn) return 'pb-1.5 pt-3';
  if (lastInTurn) return 'pb-3 pt-1.5';
  return 'py-1.5';
}

const ConversationItemRow = memo(function ConversationItemRow({
  row,
  turnId,
  itemId,
  assistantAvatarSrc,
  onOpenFile,
  onUseImageAsReference,
  onOpenGeneratedFile,
  onOpenExecutionDetails,
  retryable,
  onRetryTurn,
}: Pick<ConversationTimelineProps, 'assistantAvatarSrc' | 'onOpenFile' | 'onUseImageAsReference' | 'onOpenGeneratedFile' | 'onRetryTurn'> & {
  row: Extract<TimelineRow, { kind: 'item' }>;
  turnId: string;
  itemId: string;
  onOpenExecutionDetails: (turnId: string) => void;
  retryable: boolean;
}) {
  const status = useConversationStore((state) => state.turnsById[turnId]?.status);
  if (!status) return null;

  const content = (
    <div className="mx-auto w-full max-w-4xl px-1">
      <TimelineItemRow
        turnId={turnId}
        itemId={itemId}
        assistantAvatarSrc={assistantAvatarSrc}
        onOpenFile={onOpenFile}
        onUseImageAsReference={onUseImageAsReference}
        onOpenGeneratedFile={onOpenGeneratedFile}
        showExecutionDetails={row.executionDetailsEntry}
        onOpenExecutionDetails={onOpenExecutionDetails}
        retryable={retryable}
        onRetryTurn={onRetryTurn}
      />
    </div>
  );
  const rowProps = {
    className: timelineRowPadding(row.firstInTurn, row.lastInTurn),
    'data-timeline-row-id': row.key,
    'data-timeline-row-kind': 'item',
    'data-turn-id': turnId,
    'data-item-id': itemId,
    'data-turn-start': row.firstInTurn ? 'true' : undefined,
    'data-turn-end': row.lastInTurn ? 'true' : undefined,
    'data-turn-status': status,
  } as const;

  // Virtuoso cannot keep one DOM element wrapped around non-contiguous rows.
  // Keep one semantic Turn article and mark the remaining rows as fragments.
  return row.firstInTurn
    ? <article {...rowProps} data-testid="conversation-turn">{content}</article>
    : <div {...rowProps} role="group" data-testid="conversation-turn-fragment">{content}</div>;
});

const ConversationStatusRow = memo(function ConversationStatusRow({ row }: {
  row: Extract<TimelineRow, { kind: 'status' }>;
}) {
  const { t } = useTranslation('chat');
  const status = useConversationStore((state) => state.turnsById[row.turnId]?.status);
  if (!status || !isActiveTurnStatus(status)) return null;

  return (
    <div
      className={timelineRowPadding(row.firstInTurn, row.lastInTurn)}
      role="group"
      data-testid="conversation-turn-fragment"
      data-timeline-row-id={row.key}
      data-timeline-row-kind="status"
      data-turn-id={row.turnId}
      data-turn-start={row.firstInTurn ? 'true' : undefined}
      data-turn-end={row.lastInTurn ? 'true' : undefined}
      data-turn-status={status}
    >
      <div className="mx-auto w-full max-w-4xl px-1">
        <div className="ml-1 flex items-center gap-2 border-l border-foreground/15 pl-4 text-xs text-muted-foreground" data-testid="timeline-turn-status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>{t(`timeline.turnStatus.${status}`)}</span>
        </div>
      </div>
    </div>
  );
});

export const ConversationTimeline = forwardRef<ConversationTimelineHandle, ConversationTimelineProps>(function ConversationTimeline({
  sessionKey,
  assistantAvatarSrc,
  hasMoreHistory,
  loadingMoreHistory,
  loadMoreHistory,
  onOpenFile,
  onUseImageAsReference,
  onOpenGeneratedFile,
  retryableTurnId,
  onRetryTurn,
  emptyState,
}, forwardedRef) {
  const { t } = useTranslation('chat');
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const selectStoreRowKeys = useMemo(() => createTimelineRowKeySelector(sessionKey), [sessionKey]);
  const storeTurnIds = useConversationStore(useShallow((state) => state.turnOrderBySession[sessionKey] ?? []));
  const storeRowKeys = useConversationStore(selectStoreRowKeys);
  const latestTurnRevision = useConversationStore((state) => {
    const sessionTurnIds = state.turnOrderBySession[sessionKey] ?? [];
    const latestTurnId = sessionTurnIds[sessionTurnIds.length - 1];
    return latestTurnId ? state.turnsById[latestTurnId]?.revision ?? 0 : 0;
  });
  const followMode = useConversationStore((state) => state.followModeBySession[sessionKey] ?? 'following');
  const setFollowMode = useConversationStore((state) => state.setFollowMode);
  const [timelineWindow, setTimelineWindow] = useState<TimelineWindow>(() => ({
    sessionKey,
    rowKeys: storeRowKeys,
    firstItemIndex: FIRST_ITEM_INDEX_BASE,
  }));
  const [bottomState, setBottomState] = useState({ sessionKey, atBottom: true });
  const [executionDetailsTurnId, setExecutionDetailsTurnId] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const userScrollIntentRef = useRef<UserScrollIntent | null>(null);
  const pointerScrollActiveRef = useRef(false);
  const pointerScrollDirectionRef = useRef<ScrollDirection | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const followScrollFrameRef = useRef<number | null>(null);
  const anchorRestoreFrameRef = useRef<number | null>(null);
  const detachedVisibleAnchorRef = useRef<VisibleTimelineAnchor | null>(null);
  let resolvedTimelineWindow = timelineWindow;
  if (timelineWindow.sessionKey !== sessionKey || timelineWindow.rowKeys !== storeRowKeys) {
    // Keep data and its inverse-list origin in one render. Passing a larger
    // data array without the matching firstItemIndex for even one commit would
    // let prepended item rows displace the reader's current pixel anchor.
    resolvedTimelineWindow = reconcileTimelineWindow(timelineWindow, sessionKey, storeRowKeys);
    setTimelineWindow(resolvedTimelineWindow);
  }
  const { rowKeys, firstItemIndex } = resolvedTimelineWindow;
  const rows = useMemo(() => decodeTimelineRows(rowKeys), [rowKeys]);
  const firstRowIndexByTurnId = useMemo(() => {
    const indexes = new Map<string, number>();
    rows.forEach((row, index) => {
      if (!indexes.has(row.turnId)) indexes.set(row.turnId, index);
    });
    return indexes;
  }, [rows]);
  const atBottom = bottomState.sessionKey === sessionKey ? bottomState.atBottom : true;

  const markProgrammaticScroll = useCallback(() => {
    const now = performance.now();
    programmaticScrollUntilRef.current = Math.max(
      programmaticScrollUntilRef.current,
      now + PROGRAMMATIC_SCROLL_GUARD_MS,
    );
    const intent = userScrollIntentRef.current;
    if (!intent?.persistent || now > intent.expiresAt) userScrollIntentRef.current = null;
  }, []);

  const markUserScrollIntent = useCallback((direction: ScrollDirection, persistent = false) => {
    userScrollIntentRef.current = {
      direction,
      expiresAt: performance.now() + USER_SCROLL_INTENT_WINDOW_MS,
      persistent,
    };
    programmaticScrollUntilRef.current = 0;
  }, []);

  const handleScrollerScroll = useCallback((event: Event) => {
    const element = event.currentTarget as HTMLElement;
    const previousScrollTop = lastScrollTopRef.current;
    const nextScrollTop = element.scrollTop;
    lastScrollTopRef.current = nextScrollTop;
    const direction = nextScrollTop < previousScrollTop - 1
      ? 'up'
      : nextScrollTop > previousScrollTop + 1
        ? 'down'
        : null;
    if (!direction) return;

    const now = performance.now();
    const synthetic = !event.isTrusted;
    const pointerActive = pointerScrollActiveRef.current;
    if (!synthetic && !pointerActive && now <= programmaticScrollUntilRef.current) return;
    const intent = userScrollIntentRef.current;
    const hasUserIntent = synthetic
      || pointerActive
      || Boolean(intent && intent.direction === direction && now <= intent.expiresAt);
    if (!hasUserIntent) return;
    if (pointerActive) {
      pointerScrollDirectionRef.current = direction;
    } else if (intent && !intent.persistent) {
      userScrollIntentRef.current = null;
    }
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (direction === 'up' && distanceFromBottom > BOTTOM_THRESHOLD_PX) {
      setFollowMode(sessionKey, 'detached');
      return;
    }
    if (
      direction === 'down'
      && distanceFromBottom <= BOTTOM_THRESHOLD_PX
      && useConversationStore.getState().followModeBySession[sessionKey] === 'detached'
    ) {
      setFollowMode(sessionKey, 'following');
    }
  }, [sessionKey, setFollowMode]);

  const handleScrollerWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) markUserScrollIntent('up');
    if (event.deltaY > 0) markUserScrollIntent('down');
  }, [markUserScrollIntent]);

  const handleScrollerPointerDown = useCallback((event: PointerEvent) => {
    const element = event.currentTarget as HTMLElement;
    const nearScrollbar = event.clientX >= element.getBoundingClientRect().right - SCROLLBAR_HIT_WIDTH_PX;
    if (event.pointerType === 'mouse' && !nearScrollbar) return;
    pointerScrollActiveRef.current = true;
    pointerScrollDirectionRef.current = null;
    userScrollIntentRef.current = null;
    programmaticScrollUntilRef.current = 0;
  }, []);

  const finishPointerScroll = useCallback(() => {
    if (!pointerScrollActiveRef.current) return;
    pointerScrollActiveRef.current = false;
    const direction = pointerScrollDirectionRef.current;
    pointerScrollDirectionRef.current = null;
    if (direction) markUserScrollIntent(direction, true);
  }, [markUserScrollIntent]);

  const setScrollerElement = useCallback((element: HTMLElement | null | Window) => {
    const previousElement = scrollerElementRef.current;
    previousElement?.removeEventListener('scroll', handleScrollerScroll);
    previousElement?.removeEventListener('wheel', handleScrollerWheel);
    previousElement?.removeEventListener('pointerdown', handleScrollerPointerDown);
    const nextElement = element instanceof HTMLElement ? element : null;
    scrollerElementRef.current = nextElement;
    lastScrollTopRef.current = nextElement?.scrollTop ?? 0;
    nextElement?.addEventListener('scroll', handleScrollerScroll, { passive: true });
    nextElement?.addEventListener('wheel', handleScrollerWheel, { passive: true });
    nextElement?.addEventListener('pointerdown', handleScrollerPointerDown, { passive: true });
  }, [handleScrollerPointerDown, handleScrollerScroll, handleScrollerWheel]);

  useEffect(() => () => {
    scrollerElementRef.current?.removeEventListener('scroll', handleScrollerScroll);
    scrollerElementRef.current?.removeEventListener('wheel', handleScrollerWheel);
    scrollerElementRef.current?.removeEventListener('pointerdown', handleScrollerPointerDown);
  }, [handleScrollerPointerDown, handleScrollerScroll, handleScrollerWheel]);

  useEffect(() => {
    window.addEventListener('pointerup', finishPointerScroll, { passive: true });
    window.addEventListener('pointercancel', finishPointerScroll, { passive: true });
    return () => {
      window.removeEventListener('pointerup', finishPointerScroll);
      window.removeEventListener('pointercancel', finishPointerScroll);
    };
  }, [finishPointerScroll]);

  useEffect(() => {
    const handleScrollKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
        markUserScrollIntent('up');
      } else if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || event.key === ' ') {
        markUserScrollIntent('down');
      }
    };
    window.addEventListener('keydown', handleScrollKey);
    return () => window.removeEventListener('keydown', handleScrollKey);
  }, [markUserScrollIntent]);

  const scheduleScrollToBottomIfFollowing = useCallback(() => {
    if (followScrollFrameRef.current != null) return;
    followScrollFrameRef.current = window.requestAnimationFrame(() => {
      followScrollFrameRef.current = null;
      if ((useConversationStore.getState().followModeBySession[sessionKey] ?? 'following') !== 'following') {
        return;
      }
      const scroller = scrollerElementRef.current;
      if (!scroller) return;
      markProgrammaticScroll();
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTopRef.current = scroller.scrollTop;
    });
  }, [markProgrammaticScroll, sessionKey]);

  const cancelScheduledFollowScroll = useCallback(() => {
    if (followScrollFrameRef.current == null) return;
    window.cancelAnimationFrame(followScrollFrameRef.current);
    followScrollFrameRef.current = null;
  }, []);

  const cancelAnchorRestore = useCallback(() => {
    if (anchorRestoreFrameRef.current == null) return;
    window.cancelAnimationFrame(anchorRestoreFrameRef.current);
    anchorRestoreFrameRef.current = null;
  }, []);
  const captureVisibleRow = useCallback((): VisibleTimelineAnchor | null => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const timelineRows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-row-id]'));
    const row = timelineRows.find((candidate) => candidate.getBoundingClientRect().top >= scrollerTop - 1)
      ?? timelineRows.find((candidate) => candidate.getBoundingClientRect().bottom > scrollerTop);
    if (!row?.dataset.timelineRowId) return null;
    return {
      rowId: row.dataset.timelineRowId,
      offsetTop: row.getBoundingClientRect().top - scrollerTop,
    };
  }, []);
  const restoreVisibleRow = useCallback(function scheduleVisibleRowRestore(
    anchor: VisibleTimelineAnchor,
    attemptsRemaining: number,
  ) {
    anchorRestoreFrameRef.current = window.requestAnimationFrame(() => {
      anchorRestoreFrameRef.current = null;
      const scroller = scrollerElementRef.current;
      if (!scroller || useConversationStore.getState().followModeBySession[sessionKey] !== 'detached') return;
      const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-row-id]'))
        .find((candidate) => candidate.dataset.timelineRowId === anchor.rowId);
      if (!row) {
        // Virtuoso can briefly recycle the anchor row while applying a
        // ResizeObserver measurement. Keep the bounded restore alive until the
        // row is mounted again instead of losing the whole height correction.
        if (attemptsRemaining > 1) scheduleVisibleRowRestore(anchor, attemptsRemaining - 1);
        return;
      }
      const nextOffsetTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const offsetDelta = nextOffsetTop - anchor.offsetTop;
      detachedVisibleAnchorRef.current = anchor;
      if (Math.abs(offsetDelta) > 0.5) {
        recordTimelineScrollCorrection(offsetDelta);
        markProgrammaticScroll();
        scroller.scrollTop += offsetDelta;
        lastScrollTopRef.current = scroller.scrollTop;
      }
      if (attemptsRemaining > 1) scheduleVisibleRowRestore(anchor, attemptsRemaining - 1);
    });
  }, [markProgrammaticScroll, sessionKey]);

  const handleTimelineClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('button[aria-expanded]')) return;

    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const followModeAtChange = useConversationStore.getState().followModeBySession[sessionKey] ?? 'following';
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    if (followModeAtChange !== 'detached' && distanceFromBottom <= BOTTOM_THRESHOLD_PX) return;

    // Capture before the target button mutates expandedItemIds. A store
    // subscription can run after a child useSyncExternalStore listener has
    // already committed the new height, which loses the old pixel anchor.
    const anchor = captureVisibleRow();
    if (!anchor) return;
    if (followModeAtChange !== 'detached') setFollowMode(sessionKey, 'detached');
    detachedVisibleAnchorRef.current = anchor;
    cancelAnchorRestore();
    restoreVisibleRow(anchor, DYNAMIC_LAYOUT_ANCHOR_RESTORE_FRAMES);
  }, [cancelAnchorRestore, captureVisibleRow, restoreVisibleRow, sessionKey, setFollowMode]);

  useEffect(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller || rows.length === 0) return undefined;

    let captureFrame: number | null = null;
    const scheduleDetachedAnchorCapture = () => {
      if (captureFrame != null) window.cancelAnimationFrame(captureFrame);
      captureFrame = window.requestAnimationFrame(() => {
        captureFrame = null;
        if (useConversationStore.getState().followModeBySession[sessionKey] !== 'detached') {
          detachedVisibleAnchorRef.current = null;
          return;
        }
        detachedVisibleAnchorRef.current = captureVisibleRow();
      });
    };
    const resizeObserver = new ResizeObserver(() => {
      const currentFollowMode = useConversationStore.getState().followModeBySession[sessionKey] ?? 'following';
      if (currentFollowMode !== 'detached') {
        detachedVisibleAnchorRef.current = null;
        scheduleScrollToBottomIfFollowing();
        return;
      }
      const intent = userScrollIntentRef.current;
      const pointerGraceActive = Boolean(intent?.persistent && performance.now() <= intent.expiresAt);
      if (!pointerScrollActiveRef.current && !pointerGraceActive) {
        markProgrammaticScroll();
      }
      const anchor = detachedVisibleAnchorRef.current;
      if (!anchor) {
        scheduleDetachedAnchorCapture();
        return;
      }
      const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-timeline-row-id]'))
        .find((candidate) => candidate.dataset.timelineRowId === anchor.rowId);
      if (!row) {
        scheduleDetachedAnchorCapture();
        return;
      }
      const offsetDelta = row.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top
        - anchor.offsetTop;
      if (Math.abs(offsetDelta) <= 0.5) return;

      cancelAnchorRestore();
      restoreVisibleRow(anchor, DYNAMIC_LAYOUT_ANCHOR_RESTORE_FRAMES);
    });
    const observeTimelineRows = (node: Node, observe: boolean) => {
      if (!(node instanceof Element)) return;
      const updateObservation = (element: Element) => {
        if (observe) resizeObserver.observe(element);
        else resizeObserver.unobserve(element);
      };
      if (node.matches('[data-timeline-row-id]')) updateObservation(node);
      node.querySelectorAll('[data-timeline-row-id]').forEach(updateObservation);
    };
    scroller.querySelectorAll('[data-timeline-row-id]').forEach((row) => resizeObserver.observe(row));
    const mutationObserver = new MutationObserver((records) => {
      const currentFollowMode = useConversationStore.getState().followModeBySession[sessionKey] ?? 'following';
      if (
        currentFollowMode === 'detached'
        && !pointerScrollActiveRef.current
        && !(
          userScrollIntentRef.current?.persistent
          && performance.now() <= userScrollIntentRef.current.expiresAt
        )
      ) {
        markProgrammaticScroll();
      }
      for (const record of records) {
        record.removedNodes.forEach((node) => observeTimelineRows(node, false));
        record.addedNodes.forEach((node) => observeTimelineRows(node, true));
      }
      if (currentFollowMode === 'following') scheduleScrollToBottomIfFollowing();
    });
    mutationObserver.observe(scroller, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    scroller.addEventListener('scroll', scheduleDetachedAnchorCapture, { passive: true });
    scheduleDetachedAnchorCapture();

    return () => {
      scroller.removeEventListener('scroll', scheduleDetachedAnchorCapture);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (captureFrame != null) window.cancelAnimationFrame(captureFrame);
    };
  }, [
    cancelAnchorRestore,
    captureVisibleRow,
    markProgrammaticScroll,
    restoreVisibleRow,
    rows.length,
    scheduleScrollToBottomIfFollowing,
    sessionKey,
  ]);

  useEffect(() => () => {
    cancelAnchorRestore();
    cancelScheduledFollowScroll();
  }, [cancelAnchorRestore, cancelScheduledFollowScroll]);

  useEffect(() => {
    const stopObservers = startConversationPerformanceObservers();
    const testApi: ConversationPerformanceTestApi = {
      reset: resetConversationPerformanceMetrics,
      snapshot: getConversationPerformanceSnapshot,
    };
    const exposeTestApi = new URLSearchParams(window.location.search).get('e2eSkipSetup') === '1';
    if (exposeTestApi) window.__clawxTimelinePerformance = testApi;
    return () => {
      recordTimelineMountedRows(0);
      if (window.__clawxTimelinePerformance === testApi) {
        delete window.__clawxTimelinePerformance;
      }
      stopObservers();
    };
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    scrollToTurn: (turnId) => {
      const index = firstRowIndexByTurnId.get(turnId);
      if (index != null) {
        setFollowMode(sessionKey, 'detached');
        markProgrammaticScroll();
        // Explicit navigation must let Virtuoso retry after provisional row
        // heights are replaced by measurements from long timeline items.
        virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
      }
    },
    scrollToLatest: () => {
      if (rows.length > 0) {
        setFollowMode(sessionKey, 'following');
        markProgrammaticScroll();
        virtuosoRef.current?.scrollToIndex({ index: rows.length - 1, align: 'end', behavior: 'smooth' });
      }
    },
  }), [firstRowIndexByTurnId, markProgrammaticScroll, rows.length, sessionKey, setFollowMode]);

  useEffect(() => {
    cancelAnchorRestore();
    cancelScheduledFollowScroll();
    setFollowMode(sessionKey, 'following');
    setExecutionDetailsTurnId(null);
    detachedVisibleAnchorRef.current = null;
    userScrollIntentRef.current = null;
    pointerScrollActiveRef.current = false;
    pointerScrollDirectionRef.current = null;
    programmaticScrollUntilRef.current = 0;
  }, [cancelAnchorRestore, cancelScheduledFollowScroll, sessionKey, setFollowMode]);

  useEffect(() => {
    if (followMode !== 'following' || rows.length === 0) return;
    let frame: number | null = null;
    let framesRemaining = FOLLOW_SCROLL_SETTLE_FRAMES;
    const settleAtBottom = () => {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        scheduleScrollToBottomIfFollowing();
        framesRemaining -= 1;
        if (framesRemaining > 0
          && (useConversationStore.getState().followModeBySession[sessionKey] ?? 'following') === 'following') {
          settleAtBottom();
        }
      });
    };
    settleAtBottom();
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [followMode, latestTurnRevision, rows.length, scheduleScrollToBottomIfFollowing, sessionKey]);

  const loadEarlier = useCallback(() => {
    if (!hasMoreHistory || loadingMoreHistory || loadingRef.current) return;
    const anchor = useConversationStore.getState().followModeBySession[sessionKey] === 'detached'
      ? captureVisibleRow()
      : null;
    if (anchor) cancelAnchorRestore();
    loadingRef.current = true;
    void loadMoreHistory().finally(() => {
      loadingRef.current = false;
      if (anchor) restoreVisibleRow(anchor, 6);
    });
  }, [cancelAnchorRestore, captureVisibleRow, hasMoreHistory, loadMoreHistory, loadingMoreHistory, restoreVisibleRow, sessionKey]);

  const components = useMemo(() => ({
    Scroller: TimelineScroller,
    Header: () => hasMoreHistory ? (
      <div className="flex justify-center py-2">
        <button
          type="button"
          onClick={loadEarlier}
          disabled={loadingMoreHistory}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10 disabled:opacity-60"
          data-testid="chat-load-more-history"
        >
          {loadingMoreHistory && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {loadingMoreHistory ? t('loadingMoreHistory') : t('loadMoreHistory')}
        </button>
      </div>
    ) : null,
  }), [hasMoreHistory, loadEarlier, loadingMoreHistory, t]);

  if (rows.length === 0) {
    return <div className="h-full overflow-y-auto" data-testid="chat-scroll-container">{emptyState}</div>;
  }

  return (
    <div
      className="relative h-full min-h-0"
      onClickCapture={handleTimelineClickCapture}
      data-testid="conversation-timeline"
      data-total-row-count={rows.length}
      data-turn-count={storeTurnIds.length}
      data-follow-mode={followMode}
      data-latest-turn-revision={latestTurnRevision}
    >
      <Virtuoso
        key={sessionKey}
        ref={virtuosoRef}
        className="h-full"
        data={rows}
        firstItemIndex={firstItemIndex}
        components={components}
        computeItemKey={(_index, row) => row.key}
        itemContent={(_index, row) => row.kind === 'item'
          ? (
            <ConversationItemRow
              row={row}
              turnId={row.turnId}
              itemId={row.itemId}
              assistantAvatarSrc={assistantAvatarSrc}
              onOpenFile={onOpenFile}
              onUseImageAsReference={onUseImageAsReference}
              onOpenGeneratedFile={onOpenGeneratedFile}
              onOpenExecutionDetails={setExecutionDetailsTurnId}
              retryable={row.turnId === retryableTurnId}
              onRetryTurn={onRetryTurn}
            />
          )
          : <ConversationStatusRow row={row} />}
        initialTopMostItemIndex={rows.length - 1}
        followOutput={false}
        scrollerRef={setScrollerElement}
        atBottomThreshold={BOTTOM_THRESHOLD_PX}
        atBottomStateChange={(nextAtBottom) => {
          setBottomState({ sessionKey, atBottom: nextAtBottom });
        }}
        startReached={loadEarlier}
        rangeChanged={({ startIndex, endIndex }) => {
          recordTimelineMountedRows(Math.max(0, endIndex - startIndex + 1));
        }}
        increaseViewportBy={{ top: 1_200, bottom: 800 }}
      />
      {executionDetailsTurnId && (
        <ExecutionDetailsSheet
          turnId={executionDetailsTurnId}
          open
          onOpenChange={(open) => {
            if (!open) setExecutionDetailsTurnId(null);
          }}
        />
      )}
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            setFollowMode(sessionKey, 'following');
            markProgrammaticScroll();
            virtuosoRef.current?.scrollToIndex({ index: rows.length - 1, align: 'end', behavior: 'smooth' });
          }}
          className="absolute bottom-3 right-3 z-20 inline-flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          data-testid="chat-scroll-to-latest"
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          <span>{t('scrollToLatest')}</span>
        </button>
      )}
    </div>
  );
});
