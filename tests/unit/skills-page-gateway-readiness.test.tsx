import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skills } from '@/pages/Skills';

const fetchSkillsMock = vi.fn();
const enableSkillMock = vi.fn();
const disableSkillMock = vi.fn();
const setSkillsEnabledMock = vi.fn();
const searchSkillsMock = vi.fn();
const installSkillMock = vi.fn();
const uninstallSkillMock = vi.fn();
const marketplaceCapabilityMock = vi.fn();
const clawhubOpenSkillPathMock = vi.fn();
const openclawGetSkillsDirMock = vi.fn();
const shellOpenExternalMock = vi.fn();

const { gatewayState, skillsState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789, gatewayReady: true } as {
      state: string;
      port: number;
      gatewayReady?: boolean;
    },
  },
  skillsState: {
    skills: [] as Array<Record<string, unknown>>,
    searchResults: [] as Array<Record<string, unknown>>,
    marketplaceMeta: {} as Record<string, unknown>,
    searching: false,
  },
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: () => ({
    skills: skillsState.skills,
    loading: false,
    error: null,
    fetchSkills: fetchSkillsMock,
    enableSkill: enableSkillMock,
    disableSkill: disableSkillMock,
    setSkillsEnabled: setSkillsEnabledMock,
    searchResults: skillsState.searchResults,
    marketplaceMeta: skillsState.marketplaceMeta,
    searchSkills: searchSkillsMock,
    loadMoreMarketplaceSkills: vi.fn(),
    installSkill: installSkillMock,
    uninstallSkill: uninstallSkillMock,
    searching: skillsState.searching,
    searchError: null,
    installing: {},
  }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    openclaw: {
      getSkillsDir: () => openclawGetSkillsDirMock(),
    },
    shell: {
      openExternal: (...args: unknown[]) => shellOpenExternalMock(...args),
    },
    skills: {
      marketplaceCapability: () => marketplaceCapabilityMock(),
      clawhubOpenSkillPath: (...args: unknown[]) => clawhubOpenSkillPathMock(...args),
    },
  },
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

vi.mock('@/extensions/registry', () => ({
  rendererExtensionRegistry: {
    getSkillDetailMetaComponents: () => [],
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

describe('Skills page gateway readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: true };
    skillsState.skills = [];
    skillsState.searchResults = [];
    skillsState.marketplaceMeta = {};
    skillsState.searching = false;
    openclawGetSkillsDirMock.mockResolvedValue('/tmp/.openclaw/skills');
    shellOpenExternalMock.mockResolvedValue(undefined);
    marketplaceCapabilityMock.mockResolvedValue({ success: true, capability: { canSearch: false, canInstall: false } });
    clawhubOpenSkillPathMock.mockResolvedValue({ success: true });
    fetchSkillsMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps loading skills while gatewayReady is false and hides the banner once local skills fetch succeeds', async () => {
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('skills-gateway-banner')).not.toBeInTheDocument();
  });

  it('keeps startup readiness feedback out of the Skills page banner', async () => {
    fetchSkillsMock.mockResolvedValue(false);
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('skills-gateway-banner')).not.toBeInTheDocument();
  });

  it('still fetches local skills when the gateway is stopped', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('actions.installSkill')).not.toBeInTheDocument();
  });

  it('opens the marketplace by default when the marketplace is available', async () => {
    marketplaceCapabilityMock.mockResolvedValue({
      success: true,
      capability: { canSearch: true, canInstall: true },
    });
    skillsState.searchResults = [{
      slug: 'demo-skill',
      name: 'Demo Skill',
      description: 'Marketplace skill',
      provider: 'skillhub',
    }];
    skillsState.marketplaceMeta = {
      total: 2,
      totalKnown: true,
      catalogTotalKnown: false,
    };

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByTestId('skills-marketplace-view')).toBeInTheDocument();
    expect(screen.getByText('marketplace.totalCount')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-creative-design')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-ecommerce-growth')).toBeInTheDocument();
  });

  it('falls back to installed skills when the marketplace is unavailable', async () => {
    skillsState.skills = [
      { id: 'pdf', name: 'PDF', description: 'local skill', enabled: true, source: 'openclaw-managed' },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.queryByTestId('skills-marketplace-view')).not.toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
  });

  it('hides results from the previous category while a new category is loading', async () => {
    marketplaceCapabilityMock.mockResolvedValue({
      success: true,
      capability: { canSearch: true, canInstall: true },
    });
    skillsState.searchResults = [{
      slug: 'old-skill',
      name: 'Old Category Skill',
      description: 'Result from the previous category',
      provider: 'skillhub',
    }];
    skillsState.marketplaceMeta = { query: '' };

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByText('Old Category Skill')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('marketplace-category-creative-design'));

    expect(screen.queryByText('Old Category Skill')).not.toBeInTheDocument();
    expect(screen.getByText('marketplace.searching')).toBeInTheDocument();
  });

  it('filters the list via enabled and disabled buttons', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      { id: 'pdf', name: 'PDF', description: 'enabled skill', enabled: true, source: 'openclaw-managed' },
      { id: 'xlsx', name: 'XLSX', description: 'disabled skill', enabled: false, source: 'openclaw-managed' },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('XLSX')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('skills-filter-enabled'));
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.queryByText('XLSX')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('skills-filter-disabled'));
    expect(screen.queryByText('PDF')).not.toBeInTheDocument();
    expect(screen.getByText('XLSX')).toBeInTheDocument();
  });

  it('shows manifest versions but still hides slug badges and hash-only preinstalled versions', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      {
        id: 'self-improvement-agent',
        slug: 'self-improvement-agent',
        name: 'self-improvement',
        description: 'versionless local skill',
        enabled: true,
        source: 'openclaw-managed',
        baseDir: '/tmp/self-improvement',
      },
      {
        id: 'pdf',
        slug: 'pdf',
        name: 'pdf',
        description: 'placeholder version skill',
        enabled: true,
        version: '1.0.0',
        source: 'openclaw-managed',
        baseDir: '/tmp/pdf',
      },
      {
        id: 'docx',
        slug: 'docx',
        name: 'docx',
        description: 'hash version skill',
        enabled: true,
        source: 'openclaw-managed',
        baseDir: '/tmp/docx',
      },
      {
        id: 'custom-skill',
        slug: 'custom-skill',
        name: 'custom-skill',
        description: 'real version skill',
        enabled: true,
        version: '0.1.3',
        source: 'openclaw-managed',
        baseDir: '/tmp/custom-skill',
      },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(screen.queryByText('self-improvement-agent')).not.toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    expect(screen.getByText('v0.1.3')).toBeInTheDocument();

    fireEvent.click(screen.getByText('docx'));
    expect(screen.queryByText(/^v[a-f0-9]{40}$/i)).not.toBeInTheDocument();
  });

  it('does not show uninstall for plugin-provided skills', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      { id: 'browser-automation', slug: 'browser-automation', name: 'Browser Automation', description: 'plugin skill', enabled: true, source: 'openclaw-plugin', baseDir: '/tmp/plugin-skill' },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByText('Browser Automation'));
    expect(screen.queryByText('detail.uninstall')).not.toBeInTheDocument();
    expect(screen.getByText('detail.disable')).toBeInTheDocument();
  });
});
