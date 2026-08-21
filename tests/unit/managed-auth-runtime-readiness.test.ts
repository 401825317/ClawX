// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { isManagedRuntimeReady } from '@shared/managed-auth';

describe('managed runtime readiness', () => {
  it('allows an unmanaged distribution to start without managed credentials', () => {
    expect(isManagedRuntimeReady({
      managed: false,
      authValid: false,
      hasRelayToken: false,
      activationRequired: false,
      deviceActivated: false,
    })).toBe(true);
  });

  it.each([
    ['missing auth', { authValid: false, hasRelayToken: true, activationRequired: false, deviceActivated: false }],
    ['missing relay', { authValid: true, hasRelayToken: false, activationRequired: false, deviceActivated: false }],
    ['pending activation', { authValid: true, hasRelayToken: true, activationRequired: true, deviceActivated: false }],
  ])('blocks managed startup when %s', (_label, state) => {
    expect(isManagedRuntimeReady({ managed: true, ...state })).toBe(false);
  });

  it('allows an authenticated managed runtime and an activated device', () => {
    expect(isManagedRuntimeReady({
      managed: true,
      authValid: true,
      hasRelayToken: true,
      activationRequired: false,
      deviceActivated: false,
    })).toBe(true);
    expect(isManagedRuntimeReady({
      managed: true,
      authValid: true,
      hasRelayToken: true,
      activationRequired: true,
      deviceActivated: true,
    })).toBe(true);
  });

  it('fails closed when status is unavailable', () => {
    expect(isManagedRuntimeReady(null)).toBe(false);
  });
});
