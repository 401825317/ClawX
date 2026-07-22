import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_SESSION_STORAGE_KEY,
  isEmptyMainComposerSessionRow,
  isInternalHeartbeatSession,
  persistCurrentSessionKey,
  pickStartupSessionFallback,
  readPersistedCurrentSessionKey,
} from '../src/stores/chat/session-selection.ts';
import type { ChatSession } from '../src/stores/chat/types.ts';

function installLocalStorage(initial?: Record<string, string>): Map<string, string> {
  const values = new Map(Object.entries(initial ?? {}));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  });
  return values;
}

test('recognizes only canonical internal heartbeat session keys', () => {
  assert.equal(isInternalHeartbeatSession('agent:main:main:heartbeat'), true);
  assert.equal(isInternalHeartbeatSession('agent:main:telegram:direct:user-1:heartbeat'), true);

  assert.equal(isInternalHeartbeatSession('agent:main:heartbeat'), false);
  assert.equal(isInternalHeartbeatSession('agent:main:heartbeat-notes'), false);
  assert.equal(isInternalHeartbeatSession('agent:main:project-heartbeat-session'), false);
  assert.equal(isInternalHeartbeatSession('heartbeat'), false);
});

test('recognizes projected heartbeat isolation metadata', () => {
  assert.equal(isInternalHeartbeatSession({
    key: 'agent:main:runtime-maintenance',
    heartbeatIsolatedBaseSessionKey: 'agent:main:main',
  }), true);
  assert.equal(isInternalHeartbeatSession({
    key: 'agent:main:runtime-maintenance',
    heartbeatIsolatedBaseSessionKey: '   ',
  }), false);
});

test('startup fallback never selects heartbeat sessions', () => {
  const sessions: ChatSession[] = [
    { key: 'agent:main:main:heartbeat', updatedAt: 500 },
    {
      key: 'agent:main:runtime-maintenance',
      heartbeatIsolatedBaseSessionKey: 'agent:main:main',
      updatedAt: 400,
    },
    { key: 'agent:main:project-heartbeat-session', updatedAt: 300 },
    { key: 'agent:main:older-chat', updatedAt: 200 },
  ];

  assert.equal(
    pickStartupSessionFallback('agent:main:missing', sessions),
    'agent:main:project-heartbeat-session',
  );
  assert.equal(
    pickStartupSessionFallback('agent:main:missing', sessions.slice(0, 2)),
    null,
  );
});

test('hides only the fresh empty main generation created by sessions.reset', () => {
  assert.equal(isEmptyMainComposerSessionRow({
    key: 'agent:main:main',
    systemSent: false,
    hasActiveRun: false,
    totalTokens: 0,
  }), true);
  assert.equal(isEmptyMainComposerSessionRow({
    key: 'agent:main:main',
    systemSent: true,
    hasActiveRun: false,
  }), false);
  assert.equal(isEmptyMainComposerSessionRow({
    key: 'agent:main:main',
    systemSent: false,
    hasActiveRun: false,
    lastMessagePreview: 'Existing conversation',
  }), false);
  assert.equal(isEmptyMainComposerSessionRow({
    key: 'agent:main:session-user-created',
    systemSent: false,
    hasActiveRun: false,
  }), false);
});

test('persisted heartbeat keys are discarded while user sessions remain selectable', () => {
  const values = installLocalStorage({
    [CURRENT_SESSION_STORAGE_KEY]: 'agent:main:main:heartbeat',
  });
  assert.equal(readPersistedCurrentSessionKey(), null);
  assert.equal(values.has(CURRENT_SESSION_STORAGE_KEY), false);

  persistCurrentSessionKey('agent:main:project-heartbeat-session');
  assert.equal(
    values.get(CURRENT_SESSION_STORAGE_KEY),
    'agent:main:project-heartbeat-session',
  );

  persistCurrentSessionKey('agent:main:main:heartbeat');
  assert.equal(values.has(CURRENT_SESSION_STORAGE_KEY), false);
});
