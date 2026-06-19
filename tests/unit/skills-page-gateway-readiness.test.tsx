import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skills } from '@/pages/Skills';

const fetchSkillsMock = vi.fn();
const enableSkillMock = vi.fn();
const disableSkillMock = vi.fn();
const setSkillsEnabledMock = vi.fn();
const searchSkillsMock = vi.fn();
const loadMoreMarketplaceSkillsMock = vi.fn();
const installSkillMock = vi.fn();
const uninstallSkillMock = vi.fn();
const invokeIpcMock = vi.fn();
const hostApiFetchMock = vi.fn();

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
    loadMoreMarketplaceSkills: loadMoreMarketplaceSkillsMock,
    installSkill: installSkillMock,
    uninstallSkill: uninstallSkillMock,
    searching: false,
    searchError: null,
    installing: {},
  }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
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
    invokeIpcMock.mockResolvedValue('/tmp/.openclaw/skills');
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: false, canInstall: false } });
      }
      if (path === '/api/clawhub/open-path') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: true });
    });
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

  it('shows a starting banner while the running gateway still cannot serve skills data', async () => {
    fetchSkillsMock.mockResolvedValue(false);
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: false };
    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('skills-gateway-banner')).toHaveAttribute('data-state', 'starting');
  });

  it('still fetches local skills when the gateway is stopped', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('actions.skillMarketplace')).toBeDisabled();
  });

  it('opens the skills page in marketplace mode by default when marketplace search is available', async () => {
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      return Promise.resolve({ success: true });
    });
    skillsState.searchResults = [
      { slug: 'video-editor', name: 'Video Editor', description: 'short video editing', version: '1.0.0', keywords: ['video'] },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    expect(screen.getByText('marketplace.title')).toBeInTheDocument();
    expect(searchSkillsMock).toHaveBeenCalledWith('');
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

  it('does not show uninstall for preinstalled managed skills', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      {
        id: 'pdf',
        slug: 'pdf',
        name: 'PDF',
        description: 'preinstalled managed skill',
        enabled: true,
        source: 'openclaw-managed',
        uninstallable: false,
        baseDir: '/tmp/pdf',
      },
    ];
    skillsState.searchResults = [
      { slug: 'pdf', name: 'PDF', description: 'preinstalled managed skill', version: '1.0.0' },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByText('PDF'));
    expect(screen.queryByText('detail.uninstall')).not.toBeInTheDocument();
    expect(screen.getByText('detail.disable')).toBeInTheDocument();
  });

  it('shows uninstall for user-installed managed skills', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      {
        id: 'market-user-skill',
        slug: 'market-user-skill',
        name: 'Market User Skill',
        description: 'user installed managed skill',
        enabled: true,
        source: 'openclaw-managed',
        uninstallable: true,
        baseDir: '/tmp/market-user-skill',
      },
    ];

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByText('Market User Skill'));
    expect(screen.getByText('detail.uninstall')).toBeInTheDocument();
  });

  it('does not show uninstall in marketplace results for preinstalled installed skills', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.skills = [
      {
        id: 'pdf',
        slug: 'pdf',
        name: 'PDF',
        description: 'preinstalled managed skill',
        enabled: true,
        source: 'openclaw-managed',
        uninstallable: false,
        baseDir: '/tmp/pdf',
      },
    ];
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      if (path === '/api/skills/marketplace/search') {
        return Promise.resolve({
          success: true,
          results: [{ slug: 'pdf', name: 'PDF', description: 'preinstalled managed skill', version: '1.0.0' }],
        });
      }
      if (path === '/api/clawhub/open-path') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: true });
    });

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('skills-marketplace-button'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.queryByRole('button', { name: /uninstall/i })).not.toBeInTheDocument();
  });

  it('allows browsing but disables install when marketplace cannot install', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.searchResults = [
      { slug: 'browser-automation', name: 'Browser Automation', description: 'developer tooling', version: '1.0.0', keywords: ['developer_tools'] },
    ];
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: false } });
      }
      if (path === '/api/skills/marketplace/search') {
        return Promise.resolve({
          success: true,
          results: [{ slug: 'browser-automation', name: 'Browser Automation', description: 'developer tooling', version: '1.0.0', keywords: ['developer_tools'] }],
        });
      }
      return Promise.resolve({ success: true });
    });

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('skills-marketplace-button'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText('marketplace.securityNote')).toBeInTheDocument();
    expect(screen.getByText('marketplace.installUnavailableDescription')).toBeInTheDocument();
    expect(screen.getByText('Browser Automation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'marketplace.installUnavailable' })).toBeDisabled();
  });

  it('installs marketplace results using the normalized skill slug', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.searchResults = [
      { slug: 'browser-automation', name: 'Browser Automation', description: 'developer tooling', version: '1.0.0', keywords: ['developer_tools'] },
    ];
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      return Promise.resolve({ success: true });
    });
    installSkillMock.mockResolvedValue(undefined);

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('skills-marketplace-button'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.install' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(installSkillMock).toHaveBeenCalledWith('browser-automation', '1.0.0');
  });

  it('searches and filters marketplace skills by popular scenario categories', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.searchResults = [
      {
        slug: 'amazon-listing',
        name: 'Amazon Listing',
        description: 'amazon product listing keyword optimization',
        version: '1.0.0',
        keywords: ['ecommerce'],
      },
      {
        slug: 'browser-automation',
        name: 'Browser Automation',
        description: 'developer tooling',
        version: '1.0.0',
        keywords: ['developer_tools'],
      },
    ];
    skillsState.marketplaceMeta = {
      catalogTotal: 70414,
      catalogTotalKnown: true,
      loaded: 2,
      hasMore: true,
      nextCursor: 'cursor-1',
      query: '',
    };
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      return Promise.resolve({ success: true });
    });

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('skills-marketplace-button'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText('Amazon Listing')).toBeInTheDocument();
    expect(screen.getByText('Browser Automation')).toBeInTheDocument();
    expect(screen.getByText('marketplace.totalCount')).toBeInTheDocument();
    expect(screen.getByText('marketplace.loadMore')).toBeInTheDocument();
    fireEvent.click(screen.getByText('marketplace.loadMore'));
    expect(loadMoreMarketplaceSkillsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('marketplace-category-ecommerce-listing'));

    expect(screen.queryByText('Amazon Listing')).not.toBeInTheDocument();
    expect(screen.queryByText('Browser Automation')).not.toBeInTheDocument();
    expect(screen.getByText('marketplace.searching')).toBeInTheDocument();
    expect(searchSkillsMock).toHaveBeenCalledWith(['amazon listing', 'shopify', 'ecommerce', 'listing', 'product upload']);
  });

  it('keeps marketplace categories usable when the selected category has no results', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.searchResults = [];
    skillsState.marketplaceMeta = {
      catalogTotal: 70414,
      catalogTotalKnown: true,
      loaded: 0,
      query: '3d | blender | modeling | cad | render',
    };
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      return Promise.resolve({ success: true });
    });

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('marketplace-category-three-d-modeling'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText('marketplace.noCategoryResults')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-all')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-ecommerce-listing')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('marketplace-category-ecommerce-listing'));

    expect(searchSkillsMock).toHaveBeenCalledWith(['3d', 'blender', 'modeling', 'cad', 'render']);
    expect(searchSkillsMock).toHaveBeenCalledWith(['amazon listing', 'shopify', 'ecommerce', 'listing', 'product upload']);
  });

  it('does not show stale marketplace results while a category query is pending', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    skillsState.searchResults = [
      {
        slug: '3d-web-experience',
        name: '3D Web Experience',
        description: 'Three.js and interactive 3D scenes',
        version: '1.0.0',
        keywords: ['3d'],
      },
    ];
    skillsState.marketplaceMeta = {
      query: '3d | blender | modeling | cad | render',
      catalogTotal: 70414,
      catalogTotalKnown: true,
      loaded: 1,
    };
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/marketplace/capability') {
        return Promise.resolve({ success: true, capability: { canSearch: true, canInstall: true } });
      }
      return Promise.resolve({ success: true });
    });

    render(<Skills />);

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_600);
    });

    fireEvent.click(screen.getByTestId('marketplace-category-three-d-modeling'));

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByText('3D Web Experience')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('marketplace-category-ecommerce-listing'));

    expect(screen.queryByText('3D Web Experience')).not.toBeInTheDocument();
    expect(screen.getByText('marketplace.searching')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-three-d-modeling')).toBeInTheDocument();
    expect(screen.getByTestId('marketplace-category-ecommerce-listing')).toBeInTheDocument();
  });
});
