import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConfigInitializer } from '@/components/client/ClientConfigInitializer';

const fetchConfigMock = vi.fn();

vi.mock('@/stores/client-config', () => ({
  useClientConfigStore: (selector: (state: { fetchConfig: typeof fetchConfigMock }) => unknown) => (
    selector({ fetchConfig: fetchConfigMock })
  ),
}));

describe('ClientConfigInitializer', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const originalRequestIdleCallback = window.requestIdleCallback;
  const originalCancelIdleCallback = window.cancelIdleCallback;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 16)
    ));
    window.cancelAnimationFrame = vi.fn((id: number) => {
      window.clearTimeout(id);
    });
    window.requestIdleCallback = undefined;
    window.cancelIdleCallback = undefined;
    fetchConfigMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    window.requestIdleCallback = originalRequestIdleCallback;
    window.cancelIdleCallback = originalCancelIdleCallback;
    vi.useRealTimers();
  });

  it('does not fetch synchronously when it mounts', async () => {
    render(<ClientConfigInitializer enabled />);

    expect(fetchConfigMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_515);
    });
    expect(fetchConfigMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchConfigMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the deferred fetch when unmounted', async () => {
    const view = render(<ClientConfigInitializer enabled />);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchConfigMock).not.toHaveBeenCalled();
  });

  it('skips automatic refreshes while hidden', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    render(<ClientConfigInitializer enabled />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchConfigMock).not.toHaveBeenCalled();
  });
});
