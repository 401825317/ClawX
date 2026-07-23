/**
 * Skills Page
 * Browse and manage AI skills
 */
import { Suspense, lazy, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Search,
  Puzzle,
  Lock,
  Package,
  X,
  AlertCircle,
  Trash2,
  FolderOpen,
  Copy,
  Download,
  Layers3,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useSkillsStore } from '@/stores/skills';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { hostApi } from '@/lib/host-api';
import { isGatewayStopped } from '@/lib/gateway-status';
import { toast } from 'sonner';
import type { MarketplaceSkill, Skill } from '@/types/skill';
import type { GatewayStatus } from '@/types/gateway';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { SkillFileSections } from '@/components/file-preview/SkillFileSections';
import type { FilePreviewTarget } from '@/components/file-preview/FilePreviewOverlay';
import type { SkillFile } from '@/lib/skill-files';
import { UCLAW_CLAWHUB_MIRROR_ORIGIN, UCLAW_SKILLHUB_WEB_ORIGIN } from '@shared/junfeiai-endpoints';

const FilePreviewOverlayLazy = lazy(() =>
  import('@/components/file-preview/FilePreviewOverlay').then((m) => ({ default: m.FilePreviewOverlay })),
);

function skillFileToTarget(file: SkillFile): FilePreviewTarget {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ext: file.ext,
    mimeType: file.mimeType,
    contentType: file.contentType,
  };
}

const INSTALL_ERROR_CODES = new Set(['installTimeoutError', 'installRateLimitError']);
const FETCH_ERROR_CODES = new Set(['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError']);
const SEARCH_ERROR_CODES = new Set(['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError']);
const VALID_MARKETPLACE_SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type SkillsViewMode = 'installed' | 'marketplace';

type MarketplaceCategory = {
  id: string;
  labelKey: string;
  queries: string[];
  match: RegExp;
};

type MarketplaceCapabilityState = {
  canSearch: boolean;
  canInstall: boolean;
};

const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  { id: 'all', labelKey: 'marketplace.categories.all', queries: [''], match: /.*/ },
  {
    id: 'social-growth',
    labelKey: 'marketplace.categories.socialGrowth',
    queries: ['xiaohongshu', 'wechat', 'social media', 'content marketing'],
    match: /xiaohongshu|小红书|wechat|公众号|social|marketing|copywriting|newsletter|blog|seo/i,
  },
  {
    id: 'short-video',
    labelKey: 'marketplace.categories.shortVideo',
    queries: ['douyin', 'tiktok', 'short video', 'subtitle'],
    match: /douyin|抖音|tiktok|short video|subtitle|字幕|reel|直播/i,
  },
  {
    id: 'image-comic',
    labelKey: 'marketplace.categories.imageComic',
    queries: ['image', 'comic', 'midjourney', 'poster'],
    match: /image|生图|comic|漫画|illustration|midjourney|poster|海报/i,
  },
  {
    id: 'three-d-modeling',
    labelKey: 'marketplace.categories.threeDModeling',
    queries: ['3d', 'blender', 'modeling', 'cad'],
    match: /\b3d\b|modeling|建模|blender|cad|render|渲染|mesh/i,
  },
  {
    id: 'ecommerce-listing',
    labelKey: 'marketplace.categories.ecommerceListing',
    queries: ['amazon listing', 'shopify', 'ecommerce', 'product upload'],
    match: /ecommerce|e-commerce|电商|amazon|亚马逊|shopify|listing|上架|商品|店铺/i,
  },
  {
    id: 'product-research',
    labelKey: 'marketplace.categories.productResearch',
    queries: ['product research', 'competitor', 'keyword optimization', 'seo'],
    match: /product.research|选品|competitor|竞品|keyword|关键词|ranking|asin/i,
  },
  {
    id: 'customer-service',
    labelKey: 'marketplace.categories.customerService',
    queries: ['customer support', 'chatbot', 'crm', 'email'],
    match: /customer|客服|support|sales|销售|crm|chatbot|inbox|email|邮件/i,
  },
  {
    id: 'research-intel',
    labelKey: 'marketplace.categories.researchIntel',
    queries: ['market research', 'news', 'trend', 'analytics'],
    match: /research|调研|trend|热点|competitor|news|新闻|analytics|scrape|report/i,
  },
  {
    id: 'academic-paper',
    labelKey: 'marketplace.categories.academicPaper',
    queries: ['academic', 'paper', 'citation', 'literature'],
    match: /paper|论文|academic|literature|citation|arxiv|pubmed|scholar/i,
  },
  {
    id: 'office-docs',
    labelKey: 'marketplace.categories.officeDocs',
    queries: ['document', 'pdf', 'spreadsheet', 'presentation'],
    match: /document|docx|pdf|spreadsheet|excel|csv|ppt|slide|markdown|文档|表格|报告/i,
  },
  {
    id: 'dev-automation',
    labelKey: 'marketplace.categories.devAutomation',
    queries: ['browser automation', 'github', 'coding', 'developer tools'],
    match: /code|coding|developer|github|git|repo|test|debug|terminal|browser|automation|api|开发/i,
  },
  {
    id: 'recruiting',
    labelKey: 'marketplace.categories.recruiting',
    queries: ['resume', 'recruiting', 'interview', 'hiring'],
    match: /recruit|招聘|resume|简历|candidate|interview|面试|hiring|talent/i,
  },
  {
    id: 'education',
    labelKey: 'marketplace.categories.education',
    queries: ['education', 'learning', 'course', 'assessment'],
    match: /education|教育|learning|学习|student|学生|assessment|course|tutor|辅导/i,
  },
  {
    id: 'finance-business',
    labelKey: 'marketplace.categories.financeBusiness',
    queries: ['finance', 'accounting', 'trading', 'invoice'],
    match: /finance|财务|accounting|会计|trading|交易|payment|legal|invoice|发票|税务/i,
  },
  {
    id: 'security-risk',
    labelKey: 'marketplace.categories.securityRisk',
    queries: ['security', 'audit', 'risk', 'privacy'],
    match: /security|audit|risk|privacy|安全|审计|漏洞|permission/i,
  },
  {
    id: 'life-travel',
    labelKey: 'marketplace.categories.lifeTravel',
    queries: ['travel', 'flight', 'weather', 'health'],
    match: /map|地图|travel|旅行|flight|航班|weather|天气|health|健康|location/i,
  },
  {
    id: 'creative-design',
    labelKey: 'marketplace.categories.creativeDesign',
    queries: ['figma', 'presentation', 'design', 'image', 'poster'],
    match: /image|生图|生成图|design|figma|photo|comic|漫画|漫剧|3d|modeling|建模|render|illustration|presentation|slide/i,
  },
  {
    id: 'ecommerce-growth',
    labelKey: 'marketplace.categories.ecommerceGrowth',
    queries: ['ecommerce', 'amazon', 'shopify', 'keyword', 'seo'],
    match: /ecommerce|e-commerce|电商|amazon|亚马逊|shopify|listing|上架|asin|product|选品|keyword|关键词|seo|marketplace|商品|店铺/i,
  },
  { id: 'other', labelKey: 'marketplace.categories.other', queries: ['productivity'], match: /.*/ },
];

function formatMarketplaceCount(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat().format(Math.max(0, Math.round(value)));
}

type SkillsGatewayBannerState = 'none' | 'stopped';

function getSkillsGatewayBannerState(status: GatewayStatus): SkillsGatewayBannerState {
  if (isGatewayStopped(status)) {
    return 'stopped';
  }
  return 'none';
}

// Skill detail dialog component
interface SkillDetailDialogProps {
  skill: Skill | null;
  isOpen: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall?: (slug: string) => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}

function resolveSkillSourceLabel(skill: Skill, t: TFunction<'skills'>): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) {
    if (skill.isBundled) return t('source.badge.bundled', { defaultValue: 'Bundled dir' });
    return t('source.badge.unknown', { defaultValue: 'Unknown source' });
  }
  if (source === 'openclaw-bundled') return t('source.badge.bundled', { defaultValue: 'Bundled dir' });
  if (source === 'openclaw-managed') return t('source.badge.managed', { defaultValue: 'Managed' });
  if (source === 'openclaw-workspace') return t('source.badge.workspace', { defaultValue: 'Workspace' });
  if (source === 'openclaw-extra') return t('source.badge.extra', { defaultValue: 'Extra dirs' });
  if (source === 'openclaw-plugin') return t('source.badge.plugin', { defaultValue: 'Plugin dir' });
  if (source === 'agents-skills-personal')
    return t('source.badge.agentsPersonal', { defaultValue: 'Personal .agents' });
  if (source === 'agents-skills-project') return t('source.badge.agentsProject', { defaultValue: 'Project .agents' });
  return source;
}

function canUninstallSkill(skill: Skill): boolean {
  return skill.uninstallable === true;
}

function marketplaceSkillSlug(skill: MarketplaceSkill): string | null {
  const slug = skill.slug?.trim();
  return slug && VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug) ? slug : null;
}

function marketplaceCategory(skill: MarketplaceSkill): MarketplaceCategory {
  const searchable = [skill.name, skill.description, skill.category, ...(skill.keywords || [])]
    .filter(Boolean)
    .join(' ');
  return MARKETPLACE_CATEGORIES.slice(1).find((category) => category.match.test(searchable))
    ?? MARKETPLACE_CATEGORIES[MARKETPLACE_CATEGORIES.length - 1];
}

function safeHttpsUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function marketplaceSkillUrl(skill: MarketplaceSkill, slug: string): string {
  const sourceUrl = safeHttpsUrl(skill.sourceUrl);
  if (sourceUrl) return sourceUrl;
  return skill.provider === 'skillhub'
    ? `${UCLAW_SKILLHUB_WEB_ORIGIN}/skills/${encodeURIComponent(slug)}`
    : `${UCLAW_CLAWHUB_MIRROR_ORIGIN}/s/${encodeURIComponent(slug)}`;
}

type MarketplaceSkillCardProps = {
  skill: MarketplaceSkill;
  installedSkill?: Skill;
  installing: boolean;
  canInstall: boolean;
  onInstall: (slug: string, version?: string) => void;
  onUninstall: (slug: string) => void;
};

function MarketplaceSkillCard({
  skill,
  installedSkill,
  installing,
  canInstall,
  onInstall,
  onUninstall,
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation('skills');
  const slug = marketplaceSkillSlug(skill);
  const iconUrl = safeHttpsUrl(skill.iconUrl);
  const category = marketplaceCategory(skill);
  const sourceLabel = skill.provider === 'skillhub'
    ? t('marketplace.sourceSkillHub')
    : skill.provider === 'clawhub'
      ? t('marketplace.sourceClawHub')
      : t('marketplace.sourceUnknown');

  return (
    <article
      data-testid="marketplace-skill-card"
      className="flex min-h-[220px] flex-col rounded-lg border border-black/10 bg-surface-modal p-4 transition-colors hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.04]"
    >
      <button
        type="button"
        className="flex min-w-0 items-start gap-3 text-left"
        disabled={!slug}
        onClick={() => {
          if (slug) void hostApi.shell.openExternal(marketplaceSkillUrl(skill, slug));
        }}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/5">
          {iconUrl ? (
            <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : (
            <Package className="h-5 w-5 text-foreground/70" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{skill.name}</span>
          {skill.author && <span className="mt-1 block truncate text-tiny text-muted-foreground">{skill.author}</span>}
        </span>
      </button>

      <p className="mt-3 line-clamp-3 min-h-[3.9rem] text-sm leading-relaxed text-muted-foreground">
        {skill.description || t('marketplace.noDescription')}
      </p>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="h-5 border-0 bg-blue-500/10 px-1.5 py-0 text-2xs text-blue-700 shadow-none dark:text-blue-300">
          {sourceLabel}
        </Badge>
        <Badge variant="secondary" className="h-5 border-0 bg-black/5 px-1.5 py-0 text-2xs shadow-none dark:bg-white/10">
          {t(category.labelKey)}
        </Badge>
        {skill.version && <span className="font-mono text-tiny text-muted-foreground">v{skill.version}</span>}
      </div>

      <div className="mt-auto pt-4">
        <span className="mb-3 block min-w-0 truncate font-mono text-tiny text-foreground/55">
          {slug ?? t('marketplace.invalidSkill')}
        </span>
        {installedSkill?.uninstallable ? (
          <Button
            variant="destructive"
            size="sm"
            aria-label={t('detail.uninstall')}
            className="h-8 w-full shadow-none"
            disabled={installing || !slug}
            onClick={() => slug && onUninstall(slug)}
          >
            {installing ? <LoadingSpinner size="sm" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-8 w-full rounded-full px-3 text-xs shadow-none"
            disabled={installing || Boolean(installedSkill) || !canInstall || !slug}
            title={!slug ? t('marketplace.invalidSkill') : !canInstall ? t('marketplace.installUnavailable') : undefined}
            onClick={() => slug && onInstall(slug, skill.version)}
          >
            {installing
              ? <LoadingSpinner size="sm" />
              : installedSkill
                ? t('marketplace.installed')
                : canInstall
                  ? t('marketplace.install')
                  : t('marketplace.installUnavailable')}
          </Button>
        )}
      </div>
    </article>
  );
}

function SkillDetailDialog({ skill, isOpen, onClose, onToggle, onUninstall, onOpenFolder }: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const [openedSkillFile, setOpenedSkillFile] = useState<FilePreviewTarget | null>(null);
  const detailMetaComponents = rendererExtensionRegistry.getSkillDetailMetaComponents();

  const handleCopyPath = async () => {
    if (!skill?.baseDir) return;
    try {
      await navigator.clipboard.writeText(skill.baseDir);
      toast.success(t('toast.copiedPath'));
    } catch (err) {
      toast.error(t('toast.failedCopyPath') + ': ' + String(err));
    }
  };

  if (!skill) return null;

  const uninstallable = canUninstallSkill(skill);

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Suspense fallback={null}>
        <FilePreviewOverlayLazy file={openedSkillFile} readOnly onClose={() => setOpenedSkillFile(null)} />
      </Suspense>
      <SheetContent
        className="w-full sm:max-w-[450px] p-0 flex flex-col border-l border-black/10 dark:border-white/10 bg-surface-modal shadow-[0_0_40px_rgba(0,0,0,0.2)]"
        side="right"
      >
        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-8 py-10">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 flex items-center justify-center rounded-full bg-surface-modal border border-black/5 dark:border-white/5 shrink-0 mb-4 relative shadow-sm">
              <span className="text-3xl">{skill.icon || '🔧'}</span>
              {skill.isCore && (
                <div className="absolute -bottom-1 -right-1 bg-surface-modal rounded-full p-1 shadow-sm border border-black/5 dark:border-white/5">
                  <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                </div>
              )}
            </div>
            <h2 className="text-3xl font-serif text-foreground font-normal mb-3 text-center tracking-tight">
              {skill.name}
            </h2>
            <div
              data-skill-detail-meta-row="1"
              className="flex items-center justify-center flex-wrap gap-2.5 mb-6 opacity-80"
            >
              {skill.version && (
                <Badge
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
                >
                  v{skill.version}
                </Badge>
              )}
              <Badge
                variant="secondary"
                className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors"
              >
                {skill.isCore
                  ? t('detail.coreSystem')
                  : skill.isBundled
                    ? t('detail.bundled')
                    : t('detail.userInstalled')}
              </Badge>
              {detailMetaComponents.map((DetailMetaComponent, index) => (
                <DetailMetaComponent key={`skill-detail-meta-${index}`} skill={skill} />
              ))}
            </div>

            {skill.description && (
              <p className="text-sm text-foreground/70 font-medium leading-[1.6] text-center px-4">
                {skill.description}
              </p>
            )}
          </div>

          <div className="space-y-7 px-1">
            <div className="space-y-2">
              <h3 className="text-meta font-bold text-foreground/80">{t('detail.source')}</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70"
                >
                  {resolveSkillSourceLabel(skill, t)}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={skill.baseDir || t('detail.pathUnavailable')}
                  readOnly
                  className="h-[38px] font-mono text-xs bg-transparent border-black/10 dark:border-white/10 rounded-xl text-foreground/70"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={handleCopyPath}
                  title={t('detail.copyPath')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[38px] w-[38px] border-black/10 dark:border-white/10"
                  disabled={!skill.baseDir}
                  onClick={() => onOpenFolder?.(skill)}
                  title={t('detail.openActualFolder')}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* File Sections — read-only preview of skill content */}
            {skill.baseDir && (
              <div className="space-y-3">
                <h3 className="text-meta font-bold text-foreground/80">
                  {t('detail.sections.title', { defaultValue: '内容' })}
                </h3>
                <SkillFileSections
                  baseDir={skill.baseDir}
                  onOpen={(file) => setOpenedSkillFile(skillFileToTarget(file))}
                />
              </div>
            )}
          </div>

          {/* Centered Footer Button — uninstall / disable / enable */}
          {!skill.isCore && (
            <div className="pt-8 pb-4 flex items-center justify-center w-full px-2 max-w-[340px] mx-auto">
              <Button
                variant="outline"
                className="w-full h-[42px] text-meta rounded-full font-semibold shadow-sm bg-transparent border-black/20 dark:border-white/20 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-foreground/80 hover:text-foreground"
                onClick={() => {
                  if (uninstallable && onUninstall && skill.slug) {
                    onUninstall(skill.slug);
                    onClose();
                  } else {
                    onToggle(!skill.enabled);
                  }
                }}
              >
                {uninstallable && onUninstall
                  ? t('detail.uninstall')
                  : skill.enabled
                    ? t('detail.disable')
                    : t('detail.enable')}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function Skills() {
  const {
    skills,
    loading,
    error,
    fetchSkills,
    enableSkill,
    disableSkill,
    searchResults,
    marketplaceMeta = {},
    searchSkills,
    loadMoreMarketplaceSkills = async () => {},
    installSkill,
    uninstallSkill,
    searching,
    searchError,
    installing,
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [installQuery, setInstallQuery] = useState('');
  const [viewMode, setViewMode] = useState<SkillsViewMode>('marketplace');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [marketplaceCategoryId, setMarketplaceCategoryId] = useState('all');
  const [marketplaceCapabilityChecked, setMarketplaceCapabilityChecked] = useState(false);
  const [marketplaceCapability, setMarketplaceCapability] = useState<MarketplaceCapabilityState>({
    canSearch: false,
    canInstall: false,
  });
  const contentScrollRef = useRef<HTMLDivElement>(null);

  const gatewayRunning = gatewayStatus.state === 'running';
  const gatewayReportedReady = gatewayStatus.gatewayReady !== false;
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;
  const gatewayBannerState = getSkillsGatewayBannerState(gatewayStatus);
  const [showGatewayBanner, setShowGatewayBanner] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (gatewayBannerState === 'none') {
      timer = setTimeout(() => {
        setShowGatewayBanner(false);
      }, 0);
    } else {
      timer = setTimeout(() => {
        setShowGatewayBanner(true);
      }, 1500);
    }
    return () => clearTimeout(timer);
  }, [gatewayBannerState]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setInterval> | null = null;

    const attemptFetch = async () => {
      const ok = await fetchSkills();
      if (cancelled || !ok) return;
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    };

    void attemptFetch();

    if (gatewayRunning && !gatewayReportedReady) {
      retryTimer = setInterval(() => {
        void attemptFetch();
      }, 5_000);
    }

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearInterval(retryTimer);
      }
    };
  }, [fetchSkills, gatewayReportedReady, gatewayRunning, gatewayRuntimeKey]);

  useEffect(() => {
    let cancelled = false;
    void hostApi.skills
      .marketplaceCapability()
      .then((result) => {
        if (cancelled) return;
        setMarketplaceCapability({
          canSearch: Boolean(result.success && result.capability?.canSearch),
          canInstall: Boolean(result.success && result.capability?.canInstall),
        });
        setMarketplaceCapabilityChecked(true);
      })
      .catch(() => {
        if (!cancelled) {
          setMarketplaceCapability({ canSearch: false, canInstall: false });
          setMarketplaceCapabilityChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const safeSkills = Array.isArray(skills) ? skills : [];
  const enabledSkillsCount = safeSkills.filter((skill) => skill.enabled).length;
  const disabledSkillsCount = safeSkills.filter((skill) => !skill.enabled).length;
  const isMarketplaceView = viewMode === 'marketplace';
  const selectedMarketplaceCategory = useMemo(
    () => MARKETPLACE_CATEGORIES.find((category) => category.id === marketplaceCategoryId)
      ?? MARKETPLACE_CATEGORIES[0],
    [marketplaceCategoryId],
  );
  const marketSearchTerm = installQuery.trim();
  const marketplaceCategoryQuery = selectedMarketplaceCategory.queries.join(' | ');
  const marketplaceCategoryResultPending = marketplaceCategoryId !== 'all'
    && !marketSearchTerm
    && marketplaceMeta.query !== marketplaceCategoryQuery;
  const visibleMarketplaceSkills = marketplaceCategoryResultPending ? [] : searchResults;
  const marketplaceLoadedCount = visibleMarketplaceSkills.length;
  const marketplaceCatalogTotalKnown = marketplaceMeta.catalogTotalKnown === true
    && marketplaceMeta.catalogTotal !== undefined;
  const marketplaceSearchTotalKnown = marketplaceMeta.totalKnown === true
    && marketplaceMeta.total !== undefined;
  const marketplaceTotal = marketplaceCatalogTotalKnown
    ? marketplaceMeta.catalogTotal
    : marketplaceMeta.total;
  const marketplaceTotalKnown = marketplaceCatalogTotalKnown || marketplaceSearchTotalKnown;
  const marketplaceHasMore = Boolean(
    marketplaceMeta.hasMore
    && marketplaceMeta.nextCursor
    && marketplaceCategoryId === 'all'
    && !marketSearchTerm,
  );
  const marketplaceCategoryOptions = MARKETPLACE_CATEGORIES.filter((category) => category.id !== 'other');
  const marketplaceTotalCountLabel = marketplaceTotalKnown && marketplaceTotal !== undefined
    ? t('marketplace.totalCount', { count: formatMarketplaceCount(marketplaceTotal) })
    : t('marketplace.loadedCount', { count: formatMarketplaceCount(marketplaceLoadedCount) });
  const marketplaceLoadedCountLabel = marketplaceCategoryId === 'all'
    ? t('marketplace.loadedCount', { count: formatMarketplaceCount(visibleMarketplaceSkills.length) })
    : t('marketplace.filteredLoadedCount', {
      category: t(selectedMarketplaceCategory.labelKey),
      count: formatMarketplaceCount(visibleMarketplaceSkills.length),
    });
  const filteredSkills = safeSkills
    .filter((skill) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        q.length === 0 ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.id.toLowerCase().includes(q) ||
        (skill.slug || '').toLowerCase().includes(q) ||
        (skill.author || '').toLowerCase().includes(q);
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'enabled' ? skill.enabled : !skill.enabled);
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      if (a.enabled && !b.enabled) return -1;
      if (!a.enabled && b.enabled) return 1;
      if (a.isCore && !b.isCore) return -1;
      if (!a.isCore && b.isCore) return 1;
      return a.name.localeCompare(b.name);
    });

  const handleToggle = useCallback(
    async (skillId: string, enable: boolean) => {
      try {
        if (enable) {
          await enableSkill(skillId);
          toast.success(t('toast.enabled'));
        } else {
          await disableSkill(skillId);
          toast.success(t('toast.disabled'));
        }
      } catch (err) {
        toast.error(String(err));
      }
    },
    [enableSkill, disableSkill, t],
  );

  const hasInstalledSkills = safeSkills.some((s) => !s.isBundled);

  const handleStatusFilterClick = useCallback((nextFilter: 'enabled' | 'disabled') => {
    setStatusFilter((current) => (current === nextFilter ? 'all' : nextFilter));
  }, []);

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const skillsDir = await hostApi.openclaw.getSkillsDir();
      if (!skillsDir) {
        throw new Error('Skills directory not available');
      }
      const result = await hostApi.shell.openPath(skillsDir);
      if (result) {
        if (
          result.toLowerCase().includes('no such file') ||
          result.toLowerCase().includes('not found') ||
          result.toLowerCase().includes('failed to open')
        ) {
          toast.error(t('toast.failedFolderNotFound'));
        } else {
          throw new Error(result);
        }
      }
    } catch (err) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleOpenSkillFolder = useCallback(
    async (skill: Skill) => {
      try {
        const result = await hostApi.skills.clawhubOpenSkillPath({
          skillKey: skill.id,
          slug: skill.slug,
          baseDir: skill.baseDir,
        });
        if (!result.success) {
          throw new Error(result.error || 'Failed to open folder');
        }
      } catch (err) {
        toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
      }
    },
    [t],
  );

  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');

  useEffect(() => {
    hostApi.openclaw
      .getSkillsDir()
      .then((dir) => setSkillsDirPath(dir))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (marketplaceCapabilityChecked && isMarketplaceView && !marketplaceCapability.canSearch) {
      setViewMode('installed');
    }
  }, [isMarketplaceView, marketplaceCapability.canSearch, marketplaceCapabilityChecked]);

  useEffect(() => {
    if (!isMarketplaceView || !marketplaceCapability.canSearch) return;
    const query = installQuery.trim();
    const marketplaceQuery = query || selectedMarketplaceCategory.queries;

    const timer = setTimeout(() => {
      void searchSkills(marketplaceQuery);
    }, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [
    installQuery,
    isMarketplaceView,
    marketplaceCapability.canSearch,
    searchSkills,
    selectedMarketplaceCategory,
  ]);

  useEffect(() => {
    if (!isMarketplaceView) return;
    // A new catalog query starts at the top; pagination keeps the current position.
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [installQuery, isMarketplaceView, marketplaceCategoryId]);

  const handleInstall = useCallback(
    async (slug: string, version?: string) => {
      try {
        await installSkill(slug, version);
        toast.success(t('toast.installed'));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (INSTALL_ERROR_CODES.has(errorMessage)) {
          toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
        } else {
          toast.error(t('toast.failedInstall') + ': ' + errorMessage);
        }
      }
    },
    [installSkill, t, skillsDirPath],
  );
  const handleUninstall = useCallback(
    async (slug: string) => {
      try {
        await uninstallSkill(slug);
        toast.success(t('toast.uninstalled'));
      } catch (err) {
        toast.error(t('toast.failedUninstall') + ': ' + String(err));
      }
    },
    [uninstallSkill, t],
  );

  if (loading) {
    return (
      <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div
      data-testid="skills-page"
      className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16 pb-0">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-6 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">{t('subtitle')}</p>
          </div>

          <div className="flex items-center gap-3 md:mt-2">
            {hasInstalledSkills && (
              <button
                onClick={handleOpenSkillsFolder}
                className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0 text-meta font-medium px-4 h-8 rounded-full border border-black/10 dark:border-white/10 flex items-center justify-center text-foreground/80 hover:text-foreground"
              >
                <FolderOpen className="h-4 w-4 mr-2" />
                {t('openFolder')}
              </button>
            )}
          </div>
        </div>

        {/* Gateway Status Banner */}
        {showGatewayBanner && gatewayBannerState !== 'none' && (
          <div
            data-testid="skills-gateway-banner"
            data-state={gatewayBannerState}
            className="mb-6 p-4 rounded-xl border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3"
          >
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">{t('gatewayWarning')}</span>
          </div>
        )}

        {/* Sub Navigation and Actions */}
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-black/10 dark:border-white/10 pb-4 mb-4 shrink-0 gap-4">
          <div className="flex items-center flex-wrap gap-2 text-sm">
            <div className="flex h-8 items-center rounded-md bg-black/5 p-0.5 dark:bg-white/5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="skills-installed-button"
                onClick={() => setViewMode('installed')}
                className={cn(
                  'h-7 rounded px-3 text-meta shadow-none',
                  !isMarketplaceView && 'bg-surface-modal text-foreground shadow-sm',
                )}
              >
                {t('tabs.installed')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="skills-marketplace-button"
                disabled={!marketplaceCapability.canSearch}
                title={marketplaceCapability.canSearch ? undefined : t('marketplace.unavailable')}
                onClick={() => setViewMode('marketplace')}
                className={cn(
                  'h-7 rounded px-3 text-meta shadow-none',
                  isMarketplaceView && 'bg-surface-modal text-foreground shadow-sm',
                )}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('actions.skillMarketplace')}
              </Button>
            </div>
            <div className="relative group flex items-center bg-black/5 dark:bg-white/5 rounded-full px-3 py-1.5 focus-within:bg-black/10 transition-colors border border-transparent focus-within:border-black/10 dark:focus-within:border-white/10 mr-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                placeholder={isMarketplaceView ? t('searchMarketplace') : t('search')}
                value={isMarketplaceView ? installQuery : searchQuery}
                onChange={(event) => {
                  if (isMarketplaceView) {
                    setMarketplaceCategoryId('all');
                    setInstallQuery(event.target.value);
                  } else {
                    setSearchQuery(event.target.value);
                  }
                }}
                className="ml-2 bg-transparent outline-none w-28 md:w-40 font-normal placeholder:text-foreground/50 text-meta text-foreground"
              />
              {(isMarketplaceView ? installQuery : searchQuery) && (
                <button
                  type="button"
                  onClick={() => {
                    if (isMarketplaceView) setInstallQuery('');
                    else setSearchQuery('');
                  }}
                  className="text-foreground/50 hover:text-foreground shrink-0 ml-1"
                  aria-label={t('searchButton')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {!isMarketplaceView && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="skills-filter-enabled"
                  onClick={() => handleStatusFilterClick('enabled')}
                  className={cn(
                    'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                    statusFilter === 'enabled'
                      ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                      : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  {t('filter.enabledList', { count: enabledSkillsCount })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="skills-filter-disabled"
                  onClick={() => handleStatusFilterClick('disabled')}
                  className={cn(
                    'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                    statusFilter === 'disabled'
                      ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                      : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  {t('filter.disabledList', { count: disabledSkillsCount })}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Content Area */}
        <div
          ref={contentScrollRef}
          data-testid="skills-content-scroll"
          className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2"
        >
          {error && (
            <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>{FETCH_ERROR_CODES.has(error) ? t(`toast.${error}`, { path: skillsDirPath }) : error}</span>
            </div>
          )}

          {isMarketplaceView ? (
            <div className="flex flex-col gap-5" data-testid="skills-marketplace-view">
              <div className="flex flex-col gap-4 border-b border-black/5 pb-4 dark:border-white/5 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <h2 className="text-xl font-serif font-normal text-foreground">{t('marketplace.title')}</h2>
                  <p className="mt-1 max-w-2xl text-meta leading-relaxed text-muted-foreground">
                    {marketSearchTerm
                      ? t('marketplace.searchSubtitle')
                      : marketplaceCapability.canInstall
                        ? t('marketplace.homeSubtitle')
                        : t('marketplace.browseOnlyHomeSubtitle')}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 px-3 text-meta font-medium text-foreground dark:border-white/10">
                      <Layers3 className="h-3.5 w-3.5 text-foreground/55" />
                      {marketplaceTotalCountLabel}
                    </span>
                    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 px-3 text-meta font-medium text-foreground dark:border-white/10">
                      <Package className="h-3.5 w-3.5 text-foreground/55" />
                      {t('marketplace.loadedCount', { count: formatMarketplaceCount(marketplaceLoadedCount) })}
                    </span>
                    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 px-3 text-meta font-medium text-foreground dark:border-white/10">
                      <Sparkles className="h-3.5 w-3.5 text-foreground/55" />
                      {t('marketplace.scenarioCount', { count: marketplaceCategoryOptions.length - 1 })}
                    </span>
                  </div>
                </div>
                <div className="grid max-w-xl gap-2 text-meta leading-relaxed text-foreground/65 lg:w-[22rem]">
                  <div className="flex gap-2">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" />
                    <span>{t('marketplace.securityNote')}</span>
                  </div>
                  <div className="flex gap-2">
                    <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/50" />
                    <span>{t('marketplace.manualInstallHint', { path: skillsDirPath })}</span>
                  </div>
                  {!marketplaceCapability.canInstall && (
                    <div className="flex gap-2 text-amber-700 dark:text-amber-400">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{t('marketplace.installUnavailableDescription')}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 px-1">
                  <span className="text-meta font-semibold text-foreground/80">
                    {t('marketplace.categoryFilterLabel')}
                  </span>
                  <span className="min-w-0 shrink text-right text-tiny text-muted-foreground">
                    {marketplaceTotalKnown && marketplaceCategoryId === 'all' && !marketSearchTerm
                      ? t('marketplace.totalAndLoadedCount', {
                        total: formatMarketplaceCount(marketplaceTotal),
                        loaded: formatMarketplaceCount(marketplaceLoadedCount),
                      })
                      : marketplaceLoadedCountLabel}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2" role="list" aria-label={t('marketplace.categoryFilterLabel')}>
                  {marketplaceCategoryOptions.map((category) => (
                    <Button
                      key={category.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid={`marketplace-category-${category.id}`}
                      onClick={() => {
                        setInstallQuery('');
                        setMarketplaceCategoryId(category.id);
                      }}
                      className={cn(
                        'h-8 rounded-full border px-3 text-meta font-medium shadow-none',
                        marketplaceCategoryId === category.id
                          ? 'border-black/10 bg-black/5 text-foreground dark:border-white/10 dark:bg-white/10'
                          : 'border-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                      )}
                    >
                      {t(category.labelKey)}
                    </Button>
                  ))}
                </div>
              </div>

              {searchError && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    {SEARCH_ERROR_CODES.has(searchError.replace('Error: ', ''))
                      ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                      : searchError}
                  </span>
                </div>
              )}

              {marketplaceCategoryResultPending || (searching && visibleMarketplaceSkills.length === 0) ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <LoadingSpinner size="lg" />
                  <p className="mt-4 text-sm">{t('marketplace.searching')}</p>
                </div>
              ) : visibleMarketplaceSkills.length === 0 && !searchError ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Package className="mb-4 h-10 w-10 opacity-50" />
                  <p>
                    {marketSearchTerm
                      ? t('marketplace.noResults')
                      : marketplaceCategoryId === 'all'
                        ? t('marketplace.emptyPrompt')
                        : t('marketplace.noCategoryResults')}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleMarketplaceSkills.map((skill) => {
                    const slug = marketplaceSkillSlug(skill);
                    const installedSkill = safeSkills.find((entry) => (
                      (slug && (entry.marketplace?.slug === slug || entry.slug === slug || entry.id === slug))
                      || entry.name === skill.name
                    ));
                    return (
                      <MarketplaceSkillCard
                        key={`${skill.provider || 'marketplace'}:${slug || skill.name}`}
                        skill={skill}
                        installedSkill={installedSkill}
                        installing={slug ? Boolean(installing[slug]) : false}
                        canInstall={marketplaceCapability.canInstall}
                        onInstall={handleInstall}
                        onUninstall={handleUninstall}
                      />
                    );
                  })}
                </div>
              )}

              {marketplaceHasMore && visibleMarketplaceSkills.length > 0 && (
                <div className="flex justify-center pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="marketplace-load-more"
                    disabled={searching}
                    onClick={() => void loadMoreMarketplaceSkills()}
                    className="h-9 rounded-full px-4 text-meta shadow-none"
                  >
                    {searching ? <LoadingSpinner size="sm" /> : t('marketplace.loadMore')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {filteredSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Puzzle className="h-10 w-10 mb-4 opacity-50" />
                  <p>{searchQuery ? t('noSkillsSearch') : t('noSkillsAvailable')}</p>
                </div>
              ) : (
                filteredSkills.map((skill) => (
                  <div
                    key={skill.id}
                    className="group flex flex-row items-center justify-between py-3.5 px-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer border-b border-black/5 dark:border-white/5 last:border-0"
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <div className="flex items-start gap-4 flex-1 overflow-hidden pr-4">
                      <div className="h-10 w-10 shrink-0 flex items-center justify-center text-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 rounded-xl overflow-hidden">
                        {skill.icon || '🧩'}
                      </div>
                      <div className="flex flex-col overflow-hidden">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-foreground truncate">{skill.name}</h3>
                          {skill.isCore ? <Lock className="h-3 w-3 text-muted-foreground" /> : null}
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-1 pr-6 leading-relaxed">
                          {skill.description}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-tiny text-foreground/55 min-w-0">
                          <Badge
                            variant="secondary"
                            className="shrink-0 whitespace-nowrap px-1.5 py-0 h-5 text-2xs font-medium bg-black/5 dark:bg-white/10 border-0 shadow-none"
                          >
                            {resolveSkillSourceLabel(skill, t)}
                          </Badge>
                          <span className="truncate font-mono min-w-0">
                            {skill.baseDir || t('detail.pathUnavailable')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0" onClick={(event) => event.stopPropagation()}>
                      {skill.version && (
                        <span className="text-meta font-mono text-muted-foreground">v{skill.version}</span>
                      )}
                      {canUninstallSkill(skill) && (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="h-8 shadow-none"
                          disabled={Boolean(installing[skill.slug || skill.id])}
                          onClick={() => void handleUninstall(skill.slug || skill.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => handleToggle(skill.id, checked)}
                        disabled={skill.isCore}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Skill Detail Dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onToggle={(enabled) => {
          if (!selectedSkill) return;
          handleToggle(selectedSkill.id, enabled);
          setSelectedSkill({ ...selectedSkill, enabled });
        }}
        onUninstall={handleUninstall}
        onOpenFolder={handleOpenSkillFolder}
      />
    </div>
  );
}

export default Skills;
