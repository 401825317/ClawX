import { describe, expect, it } from 'vitest';
import {
  GatewayLifecycleController,
  LifecycleSupersededError,
} from '@electron/gateway/lifecycle-controller';

describe('GatewayLifecycleController', () => {
  it('accepts the current epoch and rejects a superseded operation', () => {
    const controller = new GatewayLifecycleController();
    const startEpoch = controller.bump('start');

    expect(() => controller.assert(startEpoch, 'start/prelaunch')).not.toThrow();

    controller.bump('stop');

    let thrown: unknown;
    try {
      controller.assert(startEpoch, 'start/process-before-fork');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LifecycleSupersededError);
    expect(thrown).toMatchObject({
      name: 'LifecycleSupersededError',
      code: 'GATEWAY_LIFECYCLE_SUPERSEDED',
      phase: 'start/process-before-fork',
      expectedEpoch: 1,
      currentEpoch: 2,
    });
  });
});
