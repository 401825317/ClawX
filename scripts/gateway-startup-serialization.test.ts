import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayManager } from '../electron/gateway/manager';
import { shouldScheduleGatewayRefresh } from '../electron/services/providers/provider-runtime-sync';

type GatewayManagerInternals = {
  restartInFlight: Promise<void> | null;
  startLock: boolean;
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('provider refresh gated as onlyIfRunning runs only in the running state', () => {
  assert.equal(shouldScheduleGatewayRefresh('running', true), true);
  assert.equal(shouldScheduleGatewayRefresh('stopped', true), false);
  assert.equal(shouldScheduleGatewayRefresh('starting', true), false);
  assert.equal(shouldScheduleGatewayRefresh('reconnecting', true), false);
  assert.equal(shouldScheduleGatewayRefresh('error', true), false);
  assert.equal(shouldScheduleGatewayRefresh('starting', false), true);
});

test('public Gateway start joins an in-flight restart without acquiring the start lock', async () => {
  const manager = new GatewayManager();
  const internals = manager as unknown as GatewayManagerInternals;
  const restart = deferred();
  internals.restartInFlight = restart.promise;

  let settled = false;
  const startPromise = manager.start({
    reason: 'junfeiai-background-verification',
    source: 'main-startup',
  }).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(internals.startLock, false);
  assert.equal(
    manager.getDiagnostics().recentLifecycleEvents?.at(-1)?.event,
    'start_joined_in_flight_restart',
  );

  restart.resolve();
  await startPromise;
  assert.equal(settled, true);
  assert.equal(internals.startLock, false);
});

test('public Gateway start propagates a failed in-flight restart without spawning a fallback start', async () => {
  const manager = new GatewayManager();
  const internals = manager as unknown as GatewayManagerInternals;
  const restart = deferred();
  internals.restartInFlight = restart.promise;

  const startPromise = manager.start({
    reason: 'api-gateway-start',
    source: '/api/gateway/start',
  });
  restart.reject(new Error('restart failed'));

  await assert.rejects(startPromise, /restart failed/u);
  assert.equal(internals.startLock, false);
  assert.equal(manager.getStatus().state, 'stopped');
});
