import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ConversationEvent,
  ConversationEventType,
} from '../shared/conversation-events';
import {
  assertConversationState,
  reduceConversationEvents,
} from '../src/stores/conversation/reducer';
import { createSessionAliasKey } from '../src/stores/conversation/identity';
import {
  createEmptyConversationState,
  type ConversationState,
  type ConversationTurn,
  type TimelineItem,
} from '../src/stores/conversation/types';

const FIXTURE_PATH = fileURLToPath(new URL(
  './fixtures/conversation-timeline-canonical-events.json',
  import.meta.url,
));
const GOLDEN_PATH = fileURLToPath(new URL(
  './fixtures/conversation-timeline-canonical-events.golden.json',
  import.meta.url,
));

const ALL_EVENT_TYPES = [
  'turn.requested',
  'run.started',
  'run.ended',
  'assistant.content',
  'thinking.content',
  'commentary.append',
  'progress.updated',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'task.updated',
  'plan.updated',
  'step.updated',
  'approval.updated',
  'artifact.updated',
  'verification.updated',
  'final.message',
  'turn.error',
  'history.checkpoint',
  'session.activity',
] as const satisfies readonly ConversationEventType[];

type MissingEventType = Exclude<ConversationEventType, typeof ALL_EVENT_TYPES[number]>;
const ALL_EVENT_TYPES_ARE_LISTED: [MissingEventType] extends [never] ? true : never = true;
void ALL_EVENT_TYPES_ARE_LISTED;

const REQUIRED_SCENARIO_TAGS = [
  'event-family-coverage',
  'direct-answer',
  'multi-round-tools',
  'missing-sequence',
  'duplicate',
  'late-sequence',
  'final-before-lifecycle',
  'terminal-precedence',
  'abort',
  'late-event',
  'disconnect-reconnect',
  'approval',
  'approval-reopen',
  'artifact-verification',
  'subagent',
  'image',
  'video',
  'session-isolation',
  'session-switch',
  'history-replay',
  'restart',
  'error',
  'recoverable-error',
] as const;

type CanonicalFixtureScenario = {
  id: string;
  description: string;
  tags: string[];
  events: ConversationEvent[];
};

type CanonicalFixture = {
  schemaVersion: 1;
  description: string;
  scenarios: CanonicalFixtureScenario[];
};

type SemanticScenarioSnapshot = {
  id: string;
  tags: string[];
  acceptedEventTypes: ConversationEventType[];
  sessions: Array<{
    sessionKey: string;
    turns: Array<ReturnType<typeof semanticTurn>>;
    diagnostics: {
      duplicateCount: number;
      staleSequenceCount: number;
      quarantineCount: number;
      assignments: Array<{
        eventId: string;
        type: ConversationEventType;
        turnId?: string;
        basis: string;
        confidence: string;
      }>;
    };
  }>;
  aliases: {
    byRunId: Array<[string, string]>;
    byTaskId: Array<[string, string]>;
    byToolCallId: Array<[string, string]>;
    byMessageId: Array<[string, string]>;
    activeBySession: Array<[string, string]>;
    pendingLocalBySession: Array<[string, string]>;
  };
};

function parseFixture(): { fixture: CanonicalFixture; raw: string } {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  return { fixture: JSON.parse(raw) as CanonicalFixture, raw };
}

function sortedEntries(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

function semanticItem(item: TimelineItem): TimelineItem {
  return JSON.parse(JSON.stringify(item)) as TimelineItem;
}

function semanticTurn(turn: ConversationTurn) {
  return {
    id: turn.id,
    status: turn.status,
    rootRunId: turn.rootRunId,
    runAliases: [...turn.runAliases],
    taskIds: [...turn.taskIds],
    hasLiveEvidence: turn.hasLiveEvidence,
    trigger: semanticItem(turn.trigger),
    items: turn.items.map(semanticItem),
    evidence: JSON.parse(JSON.stringify(turn.evidence)) as ConversationTurn['evidence'],
    sequenceWatermarks: Object.fromEntries(
      Object.entries(turn.sequenceWatermarks).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function semanticProjection(state: ConversationState) {
  return Object.keys(state.turnOrderBySession)
    .sort()
    .map((sessionKey) => ({
      sessionKey,
      turns: state.turnOrderBySession[sessionKey].map((turnId) => semanticTurn(state.turnsById[turnId])),
    }));
}

function semanticScenarioSnapshot(scenario: CanonicalFixtureScenario): SemanticScenarioSnapshot {
  const state = reduceConversationEvents(createEmptyConversationState(), scenario.events);
  assertConversationState(state);
  return {
    id: scenario.id,
    tags: [...scenario.tags].sort(),
    acceptedEventTypes: [...new Set(scenario.events.map((event) => event.type))].sort(),
    sessions: Object.keys(state.turnOrderBySession)
      .sort()
      .map((sessionKey) => {
        const diagnostics = state.ingressDiagnosticsBySession[sessionKey] ?? {
          duplicateCount: 0,
          staleSequenceCount: 0,
          quarantineCount: 0,
          assignments: [],
        };
        return {
          sessionKey,
          turns: state.turnOrderBySession[sessionKey]
            .map((turnId) => semanticTurn(state.turnsById[turnId])),
          diagnostics: {
            duplicateCount: diagnostics.duplicateCount,
            staleSequenceCount: diagnostics.staleSequenceCount,
            quarantineCount: diagnostics.quarantineCount,
            assignments: diagnostics.assignments.map((assignment) => ({
              eventId: assignment.eventId,
              type: assignment.type,
              turnId: assignment.turnId,
              basis: assignment.basis,
              confidence: assignment.confidence,
            })),
          },
        };
      }),
    aliases: {
      byRunId: sortedEntries(state.aliases.byRunId),
      byTaskId: sortedEntries(state.aliases.byTaskId),
      byToolCallId: sortedEntries(state.aliases.byToolCallId),
      byMessageId: sortedEntries(state.aliases.byMessageId),
      activeBySession: sortedEntries(state.aliases.activeBySession),
      pendingLocalBySession: sortedEntries(state.aliases.pendingLocalBySession),
    },
  };
}

function buildGolden(fixture: CanonicalFixture, fixtureRaw: string) {
  return {
    schemaVersion: 1,
    fixtureSha256: createHash('sha256').update(fixtureRaw).digest('hex'),
    eventTypes: [...ALL_EVENT_TYPES],
    scenarioTags: [...new Set(fixture.scenarios.flatMap((scenario) => scenario.tags))].sort(),
    scenarios: fixture.scenarios.map(semanticScenarioSnapshot),
  };
}

function findTurn(state: ConversationState, sessionKey: string): ConversationTurn {
  const turnIds = state.turnOrderBySession[sessionKey];
  assert.equal(turnIds?.length, 1, `expected one Turn for ${sessionKey}`);
  return state.turnsById[turnIds[0]];
}

function itemOfKind<TKind extends TimelineItem['kind']>(
  turn: ConversationTurn,
  kind: TKind,
): Extract<TimelineItem, { kind: TKind }> {
  const item = turn.items.find((candidate): candidate is Extract<TimelineItem, { kind: TKind }> => (
    candidate.kind === kind
  ));
  assert.ok(item, `expected ${kind} item in ${turn.id}`);
  return item;
}

test('canonical fixture covers all 20 event types and required abnormal scenario tags', () => {
  const { fixture } = parseFixture();
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(new Set(fixture.scenarios.map((scenario) => scenario.id)).size, fixture.scenarios.length);

  const fixtureEventTypes = [...new Set(
    fixture.scenarios.flatMap((scenario) => scenario.events.map((event) => event.type)),
  )].sort();
  assert.deepEqual(fixtureEventTypes, [...ALL_EVENT_TYPES].sort());

  const fixtureTags = new Set(fixture.scenarios.flatMap((scenario) => scenario.tags));
  for (const tag of REQUIRED_SCENARIO_TAGS) {
    assert.equal(fixtureTags.has(tag), true, `missing required canonical fixture tag: ${tag}`);
  }

  for (const scenario of fixture.scenarios) {
    for (const event of scenario.events) {
      assert.equal(event.version, 1, `${scenario.id}/${event.eventId} has an unsupported version`);
      assert.equal(typeof event.eventId, 'string');
      assert.ok(event.eventId.length > 0);
      assert.ok(event.sessionKey.length > 0);
      assert.ok(Number.isFinite(event.occurredAt));
      assert.ok(Number.isFinite(event.receivedAt));
    }
  }
});

test('canonical fixture outcomes retain the approved abnormal-ordering invariants', () => {
  const { fixture } = parseFixture();
  const scenarios = new Map(fixture.scenarios.map((scenario) => [scenario.id, scenario]));

  const core = reduceConversationEvents(createEmptyConversationState(), scenarios.get('core-event-families')!.events);
  const coreTurn = findTurn(core, 'agent:fixture:families');
  assert.equal(coreTurn.status, 'completed');
  assert.equal(itemOfKind(coreTurn, 'final-answer').message.content, 'The verified release bundle is ready.');
  assert.deepEqual(
    itemOfKind(coreTurn, 'artifact-group').artifacts.map((artifact) => [artifact.kind, artifact.availability]),
    [['image', 'available'], ['video', 'available']],
  );
  assert.deepEqual(
    itemOfKind(coreTurn, 'verification-summary').verifications.map((verification) => verification.status),
    ['passed', 'passed'],
  );
  assert.equal(itemOfKind(coreTurn, 'approval').actionable, false);
  assert.equal(itemOfKind(coreTurn, 'subtask').tasks[0].status, 'completed');

  const order = reduceConversationEvents(createEmptyConversationState(), scenarios.get('abnormal-stream-order')!.events);
  const orderTurn = findTurn(order, 'agent:fixture:order');
  assert.equal(orderTurn.status, 'completed');
  assert.equal(
    orderTurn.items.some((item) => item.kind === 'commentary' && item.text.includes('Stale streamed replacement.')),
    false,
  );
  assert.equal(order.ingressDiagnosticsBySession['agent:fixture:order'].duplicateCount, 1);
  assert.equal(order.ingressDiagnosticsBySession['agent:fixture:order'].staleSequenceCount, 1);
  assert.equal(itemOfKind(orderTurn, 'final-answer').message.content, 'The final arrived before lifecycle completion.');

  const abort = reduceConversationEvents(createEmptyConversationState(), scenarios.get('terminal-precedence-abort')!.events);
  const abortTurn = findTurn(abort, 'agent:fixture:abort');
  assert.equal(abortTurn.status, 'aborted');
  assert.equal(abortTurn.evidence.runTerminal, 'aborted');
  assert.notEqual(itemOfKind(abortTurn, 'tool-group').entries[0].status, 'running');
  assert.notEqual(itemOfKind(abortTurn, 'subtask').tasks[0].status, 'running');
  assert.equal(itemOfKind(abortTurn, 'approval').actionable, false);

  const restart = reduceConversationEvents(createEmptyConversationState(), scenarios.get('history-restart-reconnect')!.events);
  const restartTurn = findTurn(restart, 'agent:fixture:restart');
  assert.equal(restartTurn.status, 'completed');
  assert.equal(restartTurn.id, 'turn:fixture:restart');
  assert.equal(restartTurn.hasLiveEvidence, true);
  const restartFinal = itemOfKind(restartTurn, 'final-answer');
  assert.equal(restartFinal.message.content, 'Persisted answer before reconnect.');
  assert.equal(restartFinal.sourceEventIds.includes('restart:live-final'), true);
  assert.equal(restartTurn.items.filter((item) => item.kind === 'final-answer').length, 1);
  assert.ok(restartTurn.runAliases.includes('run:fixture:restart:live'));

  const isolated = reduceConversationEvents(createEmptyConversationState(), scenarios.get('session-isolation')!.events);
  assert.equal(findTurn(isolated, 'agent:fixture:session-a').id, 'turn:fixture:session-a');
  assert.equal(findTurn(isolated, 'agent:fixture:session-b').id, 'turn:fixture:session-b');
  assert.notEqual(
    isolated.aliases.byRunId[createSessionAliasKey('agent:fixture:session-a', 'run:fixture:reused')],
    isolated.aliases.byRunId[createSessionAliasKey('agent:fixture:session-b', 'run:fixture:reused')],
  );

  const error = reduceConversationEvents(createEmptyConversationState(), scenarios.get('recoverable-error')!.events);
  const errorTurn = findTurn(error, 'agent:fixture:error');
  assert.equal(errorTurn.status, 'error');
  assert.equal(itemOfKind(errorTurn, 'error').recoverable, true);
  assert.equal(errorTurn.evidence.runTerminal, 'error');
});

test('canonical fixture semantic projection is idempotent on exact replay', () => {
  const { fixture } = parseFixture();
  for (const scenario of fixture.scenarios) {
    const once = reduceConversationEvents(createEmptyConversationState(), scenario.events);
    const twice = reduceConversationEvents(once, scenario.events);
    assert.deepEqual(
      semanticProjection(twice),
      semanticProjection(once),
      `${scenario.id} changed visible projection after an exact retransmission`,
    );
  }
});

test('canonical fixture semantic snapshots match the checked-in golden', () => {
  const { fixture, raw } = parseFixture();
  const actual = buildGolden(fixture, raw);
  if (process.env.UPDATE_CONVERSATION_TIMELINE_GOLDEN === '1') {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as unknown;
  assert.deepEqual(actual, expected);
});
