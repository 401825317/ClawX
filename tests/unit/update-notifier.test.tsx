import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';

const updateState = vi.hoisted(() => ({
  status: 'available' as const,
  mode: 'installed' as const,
  packageType: 'portable_zip',
  canAutoReplace: false,
  requiresMigration: true,
  migrationReason: 'missing-portable-flag' as string | null,
  disposition: 'manual-migration' as const,
  updateInfo: { version: '2.0.4', arch: 'arm64', sha512: 'a'.repeat(128) },
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  custom: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('@/stores/update', () => ({
  useUpdateStore: (selector: (state: typeof updateState) => unknown) => selector(updateState),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { UpdateNotifier } from '@/components/update/UpdateNotifier';

type ToastRenderer = (toastId: string) => ReactElement;

describe('UpdateNotifier metadata-aware dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateState.status = 'available';
    updateState.mode = 'installed';
    updateState.packageType = 'portable_zip';
    updateState.canAutoReplace = false;
    updateState.requiresMigration = true;
    updateState.migrationReason = 'missing-portable-flag';
    updateState.disposition = 'manual-migration';
    updateState.updateInfo = { version: '2.0.4', arch: 'arm64', sha512: 'a'.repeat(128) };
  });

  it('replaces a same-version toast when the update disposition changes', () => {
    const { rerender } = render(<UpdateNotifier />);

    expect(toastMock.custom).toHaveBeenCalledTimes(1);
    const firstRenderer = toastMock.custom.mock.calls[0]?.[0] as ToastRenderer;
    expect(firstRenderer('first').props.primaryActionLabel).toBe('updates.action.downloadPortable');

    // The filesystem layout can become safe (or unsafe) while the metadata
    // version remains unchanged. The action must follow the new disposition.
    updateState.canAutoReplace = true;
    updateState.requiresMigration = false;
    updateState.migrationReason = null;
    updateState.disposition = 'auto-replace';

    act(() => {
      rerender(<UpdateNotifier />);
    });

    expect(toastMock.dismiss).toHaveBeenCalledWith('clawx-update-available');
    expect(toastMock.custom).toHaveBeenCalledTimes(2);
    const secondRenderer = toastMock.custom.mock.calls[1]?.[0] as ToastRenderer;
    expect(secondRenderer('second').props.primaryActionLabel).toBe('updates.action.downloadPortable');
    expect(secondRenderer('second').props.description).toBe('updates.toast.portableAvailableDescription');
  });

  it('does not recreate an unchanged notification key', () => {
    const { rerender } = render(<UpdateNotifier />);

    act(() => {
      rerender(<UpdateNotifier />);
    });

    expect(toastMock.custom).toHaveBeenCalledTimes(1);
  });
});
