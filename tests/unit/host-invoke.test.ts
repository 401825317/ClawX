import { describe, expect, it, vi } from 'vitest';
import { createHostInvokeDispatcher, HostApiRegistry } from '../../electron/main/ipc/host-invoke';

describe('host invoke dispatcher', () => {
  it('dispatches a typed request to the matching service action', async () => {
    const payload = { scope: 'all' };
    const services = {
      settings: {
        getAll: vi.fn(async (receivedPayload: unknown) => ({ theme: 'dark', receivedPayload })),
      },
    };
    const dispatch = createHostInvokeDispatcher(services);

    await expect(dispatch({
      id: 'req-1',
      module: 'settings',
      action: 'getAll',
      payload,
    })).resolves.toEqual({
      id: 'req-1',
      ok: true,
      data: { theme: 'dark', receivedPayload: payload },
    });

    expect(services.settings.getAll).toHaveBeenCalledWith(payload);
  });

  it('returns a validation error for malformed requests', async () => {
    const dispatch = createHostInvokeDispatcher({});

    await expect(dispatch({ id: 'bad', module: '', action: 'getAll' })).resolves.toMatchObject({
      id: 'bad',
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('returns unsupported for unknown module/action pairs', async () => {
    const dispatch = createHostInvokeDispatcher({ settings: {} });

    await expect(dispatch({
      id: 'req-2',
      module: 'settings',
      action: 'missing',
    })).resolves.toMatchObject({
      id: 'req-2',
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });
  });

  it('returns unsupported for inherited module and action names', async () => {
    const inheritedAction = vi.fn();
    const inheritedModule = vi.fn();
    const settings = Object.create({ toString: inheritedAction });
    const services = Object.create({
      inherited: { getAll: inheritedModule },
    });
    services.settings = settings;
    const dispatch = createHostInvokeDispatcher(services);

    await expect(dispatch({
      id: 'req-3',
      module: 'settings',
      action: 'toString',
    })).resolves.toMatchObject({
      id: 'req-3',
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });

    await expect(dispatch({
      id: 'req-4',
      module: 'inherited',
      action: 'getAll',
    })).resolves.toMatchObject({
      id: 'req-4',
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });

    expect(inheritedAction).not.toHaveBeenCalled();
    expect(inheritedModule).not.toHaveBeenCalled();
  });

  it('returns internal when a service action throws', async () => {
    const dispatch = createHostInvokeDispatcher({
      settings: {
        getAll: vi.fn(() => {
          throw new Error('settings unavailable');
        }),
      },
    });

    await expect(dispatch({
      id: 'req-5',
      module: 'settings',
      action: 'getAll',
    })).resolves.toEqual({
      id: 'req-5',
      ok: false,
      error: { code: 'INTERNAL', message: 'settings unavailable' },
    });
  });

  it('passes only the allowlisted recoverable contract and strips unsafe fields', async () => {
    const error = Object.assign(new Error('Browser navigation timed out at https://secret.example/token=abc'), {
      code: 'web_browser_navigation_timeout',
      recoverable: true,
      restartGateway: false,
      recovery: 'Retry https://secret.example/token=abc without restarting Gateway.',
      stack: 'private stack',
      secret: 'abc',
    });
    const dispatch = createHostInvokeDispatcher({
      settings: { getAll: vi.fn(() => { throw error; }) },
    });

    const response = await dispatch({ id: 'req-recoverable', module: 'settings', action: 'getAll' });
    expect(response).toEqual({
      id: 'req-recoverable',
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Browser navigation timed out at [redacted-url]',
        details: {
          contract: 'recoverable-v1',
          code: 'web_browser_navigation_timeout',
          recoverable: true,
          restartGateway: false,
          recovery: 'Retry [redacted-url] without restarting Gateway.',
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('private stack');
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('does not pass unknown recoverable error fields', async () => {
    const error = Object.assign(new Error('Unknown failure'), {
      code: 'arbitrary_error',
      recoverable: true,
      restartGateway: false,
      recovery: 'Run a secret command',
    });
    const dispatch = createHostInvokeDispatcher({
      settings: { getAll: vi.fn(() => { throw error; }) },
    });

    await expect(dispatch({ id: 'req-unknown', module: 'settings', action: 'getAll' })).resolves.toEqual({
      id: 'req-unknown',
      ok: false,
      error: { code: 'INTERNAL', message: 'Unknown failure' },
    });
  });

  it('dispatches extension-contributed actions registered after dispatcher creation', async () => {
    const registry = new HostApiRegistry();
    const dispatch = createHostInvokeDispatcher(registry);
    const gatewaySnapshot = vi.fn(() => ({ capturedAt: 123 }));

    const unregister = registry.registerExtensionContributions('builtin/diagnostics', [{
      module: 'diagnostics',
      actions: { gatewaySnapshot },
    }]);

    await expect(dispatch({
      id: 'req-6',
      module: 'diagnostics',
      action: 'gatewaySnapshot',
    })).resolves.toEqual({
      id: 'req-6',
      ok: true,
      data: { capturedAt: 123 },
    });
    expect(gatewaySnapshot).toHaveBeenCalledWith(undefined);

    unregister();

    await expect(dispatch({
      id: 'req-7',
      module: 'diagnostics',
      action: 'gatewaySnapshot',
    })).resolves.toMatchObject({
      id: 'req-7',
      ok: false,
      error: { code: 'UNSUPPORTED' },
    });
  });

  it('prevents extension actions from overriding existing host actions', () => {
    const registry = new HostApiRegistry();
    registry.registerCoreServices({
      settings: {
        getAll: vi.fn(() => ({ theme: 'dark' })),
      },
    });

    expect(() => registry.registerExtensionContributions('extension/conflict', [{
      module: 'settings',
      actions: { getAll: vi.fn() },
    }])).toThrow('Host API action already registered: settings.getAll');
  });
});
