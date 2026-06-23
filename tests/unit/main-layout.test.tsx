import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { MainLayout } from '@/components/layout/MainLayout';

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

vi.mock('@/components/layout/TitleBar', () => ({
  TitleBar: () => <div data-testid="titlebar" />,
}));

function renderMainLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<div data-testid="route-home" />} />
          <Route path="/models" element={<div data-testid="route-models" />} />
          <Route path="/agents" element={<div data-testid="route-agents" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function RouteSwitcher() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="route-switcher"
      onClick={() => {
        navigate('/models');
        navigate('/agents');
      }}
    >
      switch
    </button>
  );
}

describe('MainLayout platform layout', () => {
  it('uses a left/right shell on macOS with a top drag strip over content', () => {
    window.electron.platform = 'darwin';

    renderMainLayout();

    expect(screen.getByTestId('main-layout')).toHaveClass('flex-row');
    expect(screen.getByTestId('main-content')).toHaveClass('relative');
    expect(screen.getByTestId('mac-main-drag-region')).toHaveClass('drag-region');
  });

  it('keeps a top titlebar column shell on Windows', () => {
    window.electron.platform = 'win32';

    renderMainLayout();

    const layout = screen.getByTestId('main-layout');
    expect(layout).toHaveClass('flex-col');
    expect(layout).toHaveClass('bg-surface-sidebar');
    expect(screen.getByTestId('main-content')).not.toHaveClass('border-t');
    expect(screen.queryByTestId('mac-main-drag-region')).not.toBeInTheDocument();
  });

  it('keeps the shell mounted while route content switches normally on Windows', async () => {
    window.electron.platform = 'win32';

    render(
      <MemoryRouter initialEntries={['/']}>
        <RouteSwitcher />
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<div data-testid="route-home" />} />
            <Route path="/models" element={<div data-testid="route-models" />} />
            <Route path="/agents" element={<div data-testid="route-agents" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('route-home')).toBeInTheDocument();

    await act(async () => {
      screen.getByTestId('route-switcher').click();
    });
    expect(screen.queryByTestId('route-models')).not.toBeInTheDocument();
    expect(screen.getByTestId('route-agents')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
