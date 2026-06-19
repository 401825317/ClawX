/**
 * Skills Page
 * Browse and manage AI skills
 */
import { Suspense, lazy, useEffect, useState, useCallback, useMemo } from 'react';
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
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import type { Skill } from '@/types/skill';
import type { MarketplaceSkill } from '@/types/skill';
import type { GatewayStatus } from '@/types/gateway';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { SkillFileSections } from '@/components/file-preview/SkillFileSections';
import type { FilePreviewTarget } from '@/components/file-preview/FilePreviewOverlay';
import type { SkillFile } from '@/lib/skill-files';

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
  searchQuery?: string;
  searchQueries?: string[];
  match: RegExp;
};

type MarketplaceCapabilityState = {
  canSearch: boolean;
  canInstall: boolean;
};

const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  {
    id: 'social-growth',
    labelKey: 'marketplace.categories.socialGrowth',
    searchQueries: ['xiaohongshu', 'wechat', 'public account', 'social media', 'content marketing'],
    match: /\b(xiaohongshu|小红书|wechat|weixin|公众号|public account|social|social_media|marketing|content|copywriting|copy|newsletter|blog|seo|keyword|关键词|种草|运营)\b/i,
  },
  {
    id: 'short-video',
    labelKey: 'marketplace.categories.shortVideo',
    searchQueries: ['douyin', 'tiktok', 'short video', 'video editing', 'subtitle'],
    match: /\b(douyin|抖音|tiktok|short video|video|剪辑|subtitle|caption|字幕|audio|voice|tts|music|reel|直播|live)\b/i,
  },
  {
    id: 'image-comic',
    labelKey: 'marketplace.categories.imageComic',
    searchQueries: ['image', 'comic', 'midjourney', 'stable diffusion', 'poster'],
    match: /\b(image|生图|生成图|design|photo|comic|漫画|漫剧|illustration|midjourney|stable diffusion|poster|海报)\b/i,
  },
  {
    id: 'three-d-modeling',
    labelKey: 'marketplace.categories.threeDModeling',
    searchQueries: ['3d', 'blender', 'modeling', 'cad', 'render'],
    match: /\b(3d|modeling|建模|blender|cad|render|渲染|simulation|geometry|mesh)\b/i,
  },
  {
    id: 'ecommerce-listing',
    labelKey: 'marketplace.categories.ecommerceListing',
    searchQueries: ['amazon listing', 'shopify', 'ecommerce', 'listing', 'product upload'],
    match: /\b(ecommerce|e-commerce|电商|amazon|亚马逊|shopify|listing|上架|asin|product|marketplace|商品|店铺|store)\b/i,
  },
  {
    id: 'product-research',
    labelKey: 'marketplace.categories.productResearch',
    searchQueries: ['product research', 'amazon product research', 'competitor', 'keyword optimization', 'seo'],
    match: /\b(product_research|选品|asin|competitor|竞品|keyword|关键词|seo|ranking|rank|amazon|亚马逊)\b/i,
  },
  {
    id: 'customer-service',
    labelKey: 'marketplace.categories.customerService',
    searchQueries: ['customer', 'support', 'chatbot', 'crm', 'email'],
    match: /\b(customer|客服|support|service|sales|销售|crm|chatbot|bot|inbox|email|邮件|lead|线索)\b/i,
  },
  {
    id: 'research-intel',
    labelKey: 'marketplace.categories.researchIntel',
    searchQueries: ['market research', 'news', 'trend', 'analytics', 'competitor'],
    match: /\b(research|调研|trend|热点|hotspot|competitor|竞品|news|新闻|analytics|analysis|scrape|crawl|report|market research)\b/i,
  },
  {
    id: 'academic-paper',
    labelKey: 'marketplace.categories.academicPaper',
    searchQueries: ['academic', 'paper', 'citation', 'literature', 'scholar'],
    match: /\b(paper|论文|academic|literature|citation|arxiv|pubmed|research|pdf|scholar)\b/i,
  },
  {
    id: 'office-docs',
    labelKey: 'marketplace.categories.officeDocs',
    searchQueries: ['document', 'pdf', 'spreadsheet', 'presentation', 'translation'],
    match: /\b(document|document_processing|docs|docx|pdf|spreadsheet|excel|csv|ppt|powerpoint|slide|report|markdown|translation|translate|table|文档|表格|报告)\b/i,
  },
  {
    id: 'dev-automation',
    labelKey: 'marketplace.categories.devAutomation',
    searchQueries: ['browser automation', 'github', 'coding', 'developer tools', 'api'],
    match: /\b(code|coding|developer|developer_tools|programming|github|git|repo|repository|pull request|pr|review|test|testing|debug|terminal|shell|browser|web|playwright|automation|api|openapi|开发|自动化)\b/i,
  },
  {
    id: 'recruiting',
    labelKey: 'marketplace.categories.recruiting',
    searchQueries: ['resume', 'recruiting', 'interview', 'candidate', 'hiring'],
    match: /\b(recruit|招聘|resume|简历|hr|candidate|interview|面试|job|hiring|talent)\b/i,
  },
  {
    id: 'education',
    labelKey: 'marketplace.categories.education',
    searchQueries: ['education', 'learning', 'course', 'student', 'assessment'],
    match: /\b(education|教育|learning|学习|student|学生|assessment|考试|测评|test prep|school|course|tutor|辅导)\b/i,
  },
  {
    id: 'finance-business',
    labelKey: 'marketplace.categories.financeBusiness',
    searchQueries: ['finance', 'accounting', 'trading', 'invoice', 'legal'],
    match: /\b(finance|财务|accounting|会计|trading|交易|crypto|bitcoin|payment|legal|法律|business|erp|billing|invoice|发票|税务)\b/i,
  },
  {
    id: 'security-risk',
    labelKey: 'marketplace.categories.securityRisk',
    searchQueries: ['security', 'audit', 'risk', 'privacy', 'vulnerability'],
    match: /\b(security|security_testing|audit|shield|risk|permission|privacy|safe|safety|风控|安全|审计|漏洞)\b/i,
  },
  {
    id: 'life-travel',
    labelKey: 'marketplace.categories.lifeTravel',
    searchQueries: ['travel', 'flight', 'weather', 'map', 'health'],
    match: /\b(map|地图|lbs|travel|旅行|flight|航班|weather|天气|health|健康|home_automation|home assistant|智能家居|location|poi)\b/i,
  },
  {
    id: 'creative-design',
    labelKey: 'marketplace.categories.creativeDesign',
    searchQueries: ['figma', 'presentation', 'design', 'image', 'poster'],
    match: /\b(image|生图|生成图|design|figma|photo|comic|漫画|漫剧|3d|modeling|建模|render|canvas|illustration|presentation|slide)\b/i,
  },
  {
    id: 'ecommerce-growth',
    labelKey: 'marketplace.categories.ecommerceGrowth',
    searchQueries: ['ecommerce', 'amazon', 'shopify', 'keyword', 'seo'],
    match: /\b(ecommerce|e-commerce|电商|amazon|亚马逊|shopify|listing|上架|asin|product|选品|keyword|关键词|seo|marketplace|商品|店铺)\b/i,
  },
  {
    id: 'other',
    labelKey: 'marketplace.categories.other',
    match: /.*/,
  },
];

const MARKETPLACE_CATEGORIES_BY_ID = new Map(
  MARKETPLACE_CATEGORIES.map((category) => [category.id, category]),
);

function getMarketplaceCategorySearchQuery(category?: MarketplaceCategory): string | string[] {
  if (!category) return '';
  if (category.searchQueries && category.searchQueries.length > 0) return category.searchQueries;
  return category.searchQuery ?? '';
}

function serializeMarketplaceSearchQuery(query: string | string[]): string {
  return Array.isArray(query) ? query.join('\u001f') : query;
}

function formatMarketplaceSearchQuery(query: string | string[]): string {
  return Array.isArray(query) ? query.join(' | ') : query;
}

const MARKETPLACE_KEYWORD_CATEGORY_PRIORITY: Array<{
  categoryId: string;
  keywords: Set<string>;
}> = [
  {
    categoryId: 'security-risk',
    keywords: new Set(['security', 'security_testing', 'privacy', 'risk', 'audit', 'permission', 'safety']),
  },
  {
    categoryId: 'product-research',
    keywords: new Set(['product_research', 'keyword_optimization', 'competitor_analysis', 'seo', 'asin']),
  },
  {
    categoryId: 'ecommerce-listing',
    keywords: new Set(['ecommerce', 'e-commerce', 'amazon', 'shopify', 'listing', 'marketplace']),
  },
  {
    categoryId: 'social-growth',
    keywords: new Set(['content', 'content_marketing', 'social_media', 'marketing', 'copywriting', 'newsletter', 'blog', 'seo']),
  },
  {
    categoryId: 'short-video',
    keywords: new Set(['video', 'short_video', 'tiktok', 'douyin', 'audio', 'voice', 'tts', 'subtitle', 'music']),
  },
  {
    categoryId: 'three-d-modeling',
    keywords: new Set(['3d', 'modeling', 'blender', 'cad', 'render']),
  },
  {
    categoryId: 'image-comic',
    keywords: new Set(['image', 'image_generation', 'comic', 'manga', 'illustration', 'design']),
  },
  {
    categoryId: 'customer-service',
    keywords: new Set(['customer_support', 'support', 'sales', 'crm', 'chatbot', 'email']),
  },
  {
    categoryId: 'academic-paper',
    keywords: new Set(['paper', 'academic', 'literature', 'citation', 'arxiv', 'scholar']),
  },
  {
    categoryId: 'research-intel',
    keywords: new Set(['research', 'market_research', 'trend', 'news', 'analytics', 'scraping']),
  },
  {
    categoryId: 'office-docs',
    keywords: new Set(['document', 'document_processing', 'spreadsheet', 'excel', 'csv', 'pdf', 'ppt', 'report', 'markdown', 'translation']),
  },
  {
    categoryId: 'dev-automation',
    keywords: new Set(['coding', 'developer_tools', 'development', 'debugging', 'testing', 'browser_automation', 'repo', 'github']),
  },
  {
    categoryId: 'recruiting',
    keywords: new Set(['recruiting', 'resume', 'hr', 'candidate', 'interview']),
  },
  {
    categoryId: 'education',
    keywords: new Set(['education', 'learning', 'assessment', 'student', 'course']),
  },
  {
    categoryId: 'finance-business',
    keywords: new Set(['finance', 'accounting', 'legal', 'trading', 'crypto', 'bitcoin', 'payment', 'erp', 'billing']),
  },
  {
    categoryId: 'life-travel',
    keywords: new Set(['map', 'lbs', 'travel', 'flight', 'weather', 'health', 'home_automation']),
  },
];

function normalizeMarketplaceKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function formatMarketplaceCount(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.NumberFormat().format(Math.max(0, Math.round(value)));
}

function getMarketplaceCapabilityCount(options: {
  total?: number;
  totalKnown?: boolean;
  loaded: number;
  t: TFunction<'skills'>;
}): string {
  if (options.totalKnown && typeof options.total === 'number' && options.total > 0) {
    return options.t('marketplace.totalCount', {
      count: formatMarketplaceCount(options.total),
    });
  }
  return options.t('marketplace.loadedCount', {
    count: formatMarketplaceCount(options.loaded),
  });
}

type SkillsGatewayBannerState = 'none' | 'starting' | 'stopped';

function isSkillsGatewayReady(status: GatewayStatus, skillsFeatureReady: boolean): boolean {
  return status.state === 'running' && (status.gatewayReady !== false || skillsFeatureReady);
}

function getSkillsGatewayBannerState(
  status: GatewayStatus,
  skillsFeatureReady: boolean,
): SkillsGatewayBannerState {
  if (status.state === 'starting' || status.state === 'reconnecting') {
    return 'starting';
  }
  if (status.state === 'running' && !isSkillsGatewayReady(status, skillsFeatureReady)) {
    return 'starting';
  }
  if (status.state === 'stopped' || status.state === 'error') {
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
  if (source === 'agents-skills-personal') return t('source.badge.agentsPersonal', { defaultValue: 'Personal .agents' });
  if (source === 'agents-skills-project') return t('source.badge.agentsProject', { defaultValue: 'Project .agents' });
  return source;
}

function canUninstallSkill(skill: Skill): boolean {
  return skill.uninstallable === true;
}

function resolveMarketplaceSkillSlug(skill: MarketplaceSkill): string | null {
  const slug = typeof skill.slug === 'string' ? skill.slug.trim() : '';
  if (!slug || slug === 'undefined' || slug === 'null') return null;
  return VALID_MARKETPLACE_SKILL_SLUG_RE.test(slug) ? slug : null;
}

function getMarketplaceSkillSearchText(skill: MarketplaceSkill): string {
  return [
    ...(skill.keywords || []),
    resolveMarketplaceSkillSlug(skill),
    skill.name,
    skill.description,
    skill.author,
  ].filter(Boolean).join(' ');
}

function resolveMarketplaceCategory(skill: MarketplaceSkill): MarketplaceCategory {
  const keywords = (skill.keywords || []).map(normalizeMarketplaceKeyword);
  for (const rule of MARKETPLACE_KEYWORD_CATEGORY_PRIORITY) {
    if (keywords.some((keyword) => rule.keywords.has(keyword))) {
      const category = MARKETPLACE_CATEGORIES_BY_ID.get(rule.categoryId);
      if (category) return category;
    }
  }

  const haystack = getMarketplaceSkillSearchText(skill);
  return MARKETPLACE_CATEGORIES.find((category) => category.match.test(haystack))
    ?? MARKETPLACE_CATEGORIES[MARKETPLACE_CATEGORIES.length - 1];
}

function resolveMarketplaceSkillUrl(skill: MarketplaceSkill, skillSlug: string): string {
  if (skill.sourceUrl) return skill.sourceUrl;
  if (skill.provider === 'skillhub') {
    return `https://skillhub.cn/skills/${skillSlug}`;
  }
  return `https://mirror-cn.clawhub.com/s/${skillSlug}`;
}

function getMarketplaceSourceLabel(skill: MarketplaceSkill, t: TFunction<'skills'>): string {
  if (skill.provider === 'skillhub') return t('marketplace.sourceSkillHub');
  if (skill.provider === 'clawhub' || skill.source === 'clawhub') return t('marketplace.sourceClawHub');
  return skill.source || t('marketplace.sourceUnknown');
}

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill;
  installedSkill?: Skill;
  installing: boolean;
  canInstall: boolean;
  onInstall: (slug: string, version?: string) => void;
  onUninstall: (slug: string) => void;
}

function MarketplaceSkillCard({
  skill,
  installedSkill,
  installing,
  canInstall,
  onInstall,
  onUninstall,
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation('skills');
  const isInstalled = Boolean(installedSkill);
  const canUninstallInstalledSkill = installedSkill ? canUninstallSkill(installedSkill) : false;
  const skillSlug = resolveMarketplaceSkillSlug(skill);
  const canInstallSkill = Boolean(skillSlug) && canInstall;
  const category = resolveMarketplaceCategory(skill);

  return (
    <div
      data-testid="marketplace-skill-card"
      className={cn(
        'group flex min-h-[216px] flex-col rounded-lg border border-black/10 bg-surface-modal p-4 transition-colors dark:border-white/10',
        skillSlug && 'cursor-pointer hover:border-black/20 hover:bg-black/[0.03] dark:hover:border-white/20 dark:hover:bg-white/[0.05]',
      )}
      onClick={() => {
        if (!skillSlug) return;
        invokeIpc('shell:openExternal', resolveMarketplaceSkillUrl(skill, skillSlug));
      }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/5">
          {skill.iconUrl ? (
            <img src={skill.iconUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <Package className="h-5 w-5 text-foreground/70" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
            {skill.name}
          </h3>
          {skill.author && (
            <div className="mt-1 truncate text-tiny text-muted-foreground">
              {skill.author}
            </div>
          )}
        </div>
      </div>

      <p className="mt-3 line-clamp-3 min-h-[3.9rem] text-sm leading-relaxed text-muted-foreground">
        {skill.description || t('marketplace.noDescription')}
      </p>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 text-tiny text-foreground/55">
        <Badge variant="secondary" className="h-5 shrink-0 whitespace-nowrap border-0 bg-blue-500/10 px-1.5 py-0 text-2xs font-medium text-blue-700 shadow-none dark:text-blue-300">
          {getMarketplaceSourceLabel(skill, t)}
        </Badge>
        <Badge variant="secondary" className="h-5 shrink-0 whitespace-nowrap border-0 bg-black/5 px-1.5 py-0 text-2xs font-medium shadow-none dark:bg-white/10">
          {t(category.labelKey)}
        </Badge>
        {skill.version && (
          <span className="shrink-0 text-tiny font-mono text-muted-foreground">
            v{skill.version}
          </span>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-4" onClick={e => e.stopPropagation()}>
        <span className="min-w-0 truncate font-mono text-tiny text-foreground/55">
          {skillSlug ?? t('marketplace.invalidSkill')}
        </span>
        {isInstalled && canUninstallInstalledSkill ? (
          <Button
            variant="destructive"
            size="sm"
            aria-label={t('detail.uninstall')}
            onClick={() => {
              if (skillSlug) onUninstall(skillSlug);
            }}
            disabled={installing || !skillSlug}
            className="h-8 w-full shadow-none"
          >
            {installing ? <LoadingSpinner size="sm" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              if (!canInstallSkill || !skillSlug) return;
              onInstall(skillSlug, skill.version);
            }}
            disabled={installing || isInstalled || !canInstallSkill}
            title={!skillSlug ? t('marketplace.invalidSkill') : !canInstall ? t('marketplace.installUnavailable') : undefined}
            className="h-8 w-full rounded-full px-3 text-xs font-medium shadow-none"
          >
            {installing ? (
              <LoadingSpinner size="sm" />
            ) : isInstalled ? (
              t('marketplace.installed')
            ) : !canInstallSkill ? (
              t('marketplace.installUnavailable')
            ) : (
              t('marketplace.install')
            )}
          </Button>
        )}
      </div>
    </div>
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
        <FilePreviewOverlayLazy
          file={openedSkillFile}
          readOnly
          onClose={() => setOpenedSkillFile(null)}
        />
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
            <div data-skill-detail-meta-row="1" className="flex items-center justify-center flex-wrap gap-2.5 mb-6 opacity-80">
              {skill.version && (
                <Badge variant="secondary" className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors">
                  v{skill.version}
                </Badge>
              )}
              <Badge variant="secondary" className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] border-0 shadow-none text-foreground/70 transition-colors">
                {skill.isCore ? t('detail.coreSystem') : skill.isBundled ? t('detail.bundled') : t('detail.userInstalled')}
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
                <Badge variant="secondary" className="shrink-0 whitespace-nowrap font-mono text-tiny font-medium px-3 py-0.5 rounded-full bg-black/[0.04] dark:bg-white/[0.08] border-0 shadow-none text-foreground/70">
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
                  : (skill.enabled ? t('detail.disable') : t('detail.enable'))}
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
    marketplaceMeta,
    searchSkills,
    loadMoreMarketplaceSkills,
    installSkill,
    uninstallSkill,
    searching,
    searchError,
    installing
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [installQuery, setInstallQuery] = useState('');
  const [viewMode, setViewMode] = useState<SkillsViewMode>('marketplace');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [marketplaceCategoryFilter, setMarketplaceCategoryFilter] = useState('all');
  const [marketplaceCapabilityChecked, setMarketplaceCapabilityChecked] = useState(false);
  const [marketplaceCapability, setMarketplaceCapability] = useState<MarketplaceCapabilityState>({
    canSearch: false,
    canInstall: false,
  });

  const gatewayRunning = gatewayStatus.state === 'running';
  const gatewayReportedReady = gatewayStatus.gatewayReady !== false;
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;
  const [skillsFeatureReady, setSkillsFeatureReady] = useState(false);
  const gatewayBannerState = getSkillsGatewayBannerState(gatewayStatus, skillsFeatureReady);
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
      setSkillsFeatureReady(true);
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    };

    setSkillsFeatureReady(false);
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
    void hostApiFetch<{ success: boolean; capability?: { canSearch?: boolean; canInstall?: boolean } }>('/api/skills/marketplace/capability')
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
          setMarketplaceCapability({
            canSearch: false,
            canInstall: false,
          });
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
  const filteredSkills = safeSkills.filter((skill) => {
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch = q.length === 0
      || skill.name.toLowerCase().includes(q)
      || skill.description.toLowerCase().includes(q)
      || skill.id.toLowerCase().includes(q)
      || (skill.slug || '').toLowerCase().includes(q)
      || (skill.author || '').toLowerCase().includes(q);
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'enabled' ? skill.enabled : !skill.enabled);
    return matchesSearch && matchesStatus;
  }).sort((a, b) => {
    if (a.enabled && !b.enabled) return -1;
    if (!a.enabled && b.enabled) return 1;
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    return a.name.localeCompare(b.name);
  });


  const handleToggle = useCallback(async (skillId: string, enable: boolean) => {
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
  }, [enableSkill, disableSkill, t]);

  const hasInstalledSkills = safeSkills.some(s => !s.isBundled);
  const isMarketplaceView = viewMode === 'marketplace';
  const marketplaceCanSearch = marketplaceCapability.canSearch;
  const marketplaceCanInstall = marketplaceCapability.canInstall;
  const marketSearchTerm = installQuery.trim();
  const selectedMarketplaceCategory = MARKETPLACE_CATEGORIES_BY_ID.get(marketplaceCategoryFilter);
  const marketplaceCategorySearchQuery = getMarketplaceCategorySearchQuery(selectedMarketplaceCategory);
  const isMarketplaceCategorySearch = marketplaceCategoryFilter !== 'all' && !marketSearchTerm;
  const marketplaceCategoryQueryMeta = formatMarketplaceSearchQuery(marketplaceCategorySearchQuery);
  const isCurrentCategoryResultSet = isMarketplaceCategorySearch && marketplaceMeta.query === marketplaceCategoryQueryMeta;
  const marketplaceCategoryResultPending = isMarketplaceCategorySearch && !isCurrentCategoryResultSet;
  const marketplaceCategoryMatches = useMemo(() => {
    if (marketplaceCategoryFilter === 'all') return searchResults;
    if (marketplaceCategoryResultPending) return [];
    return searchResults;
  }, [marketplaceCategoryFilter, marketplaceCategoryResultPending, searchResults]);
  const visibleMarketplaceSkills = marketplaceCategoryFilter === 'all'
    ? searchResults
    : marketplaceCategoryMatches;
  const marketplaceTotalKnown = Boolean(marketplaceMeta.catalogTotalKnown ?? marketplaceMeta.totalKnown);
  const marketplaceTotal = marketplaceMeta.catalogTotal ?? marketplaceMeta.total;
  const marketplaceHasMore = Boolean(marketplaceMeta.hasMore && marketplaceMeta.nextCursor && marketplaceCategoryFilter === 'all' && !marketSearchTerm);
  const marketplaceLoadedCount = visibleMarketplaceSkills.length;
  const marketplaceTotalCountLabel = getMarketplaceCapabilityCount({
    total: marketplaceTotal,
    totalKnown: marketplaceTotalKnown,
    loaded: marketplaceLoadedCount,
    t,
  });
  const marketplaceCategoryOptions = [
    {
      id: 'all',
      label: t('marketplace.categories.all'),
    },
    ...MARKETPLACE_CATEGORIES.filter((category) => category.id !== 'other').map((category) => ({
      id: category.id,
      label: t(category.labelKey),
    })),
  ];
  const marketplaceLoadedCountLabel = marketplaceCategoryFilter === 'all'
    ? t('marketplace.loadedCount', { count: visibleMarketplaceSkills.length })
    : t('marketplace.filteredLoadedCount', {
      category: selectedMarketplaceCategory ? t(selectedMarketplaceCategory.labelKey) : t('marketplace.categories.all'),
      count: visibleMarketplaceSkills.length,
    });

  const handleMarketplaceCategoryClick = useCallback((categoryId: string) => {
    setMarketplaceCategoryFilter(categoryId);
    setInstallQuery('');
  }, []);

  const marketplaceSearchKey = [
    isMarketplaceView ? 'marketplace' : 'installed',
    marketplaceCanSearch ? 'searchable' : 'unavailable',
    marketSearchTerm,
    marketplaceCategoryFilter,
    serializeMarketplaceSearchQuery(marketplaceCategorySearchQuery),
  ].join('|');

  const handleStatusFilterClick = useCallback((nextFilter: 'enabled' | 'disabled') => {
    setViewMode('installed');
    setStatusFilter((current) => (current === nextFilter ? 'all' : nextFilter));
  }, []);

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const skillsDir = await invokeIpc<string>('openclaw:getSkillsDir');
      if (!skillsDir) {
        throw new Error('Skills directory not available');
      }
      const result = await invokeIpc<string>('shell:openPath', skillsDir);
      if (result) {
        if (result.toLowerCase().includes('no such file') || result.toLowerCase().includes('not found') || result.toLowerCase().includes('failed to open')) {
          toast.error(t('toast.failedFolderNotFound'));
        } else {
          throw new Error(result);
        }
      }
    } catch (err) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleOpenSkillFolder = useCallback(async (skill: Skill) => {
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/open-path', {
        method: 'POST',
        body: JSON.stringify({
          skillKey: skill.id,
          slug: skill.slug,
          baseDir: skill.baseDir,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to open folder');
      }
    } catch (err) {
      toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
    }
  }, [t]);

  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');

  useEffect(() => {
    invokeIpc<string>('openclaw:getSkillsDir')
      .then((dir) => setSkillsDirPath(dir as string))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (marketplaceCapabilityChecked && isMarketplaceView && !marketplaceCanSearch) {
      setViewMode('installed');
    }
  }, [isMarketplaceView, marketplaceCanSearch, marketplaceCapabilityChecked]);

  useEffect(() => {
    if (!isMarketplaceView || !marketplaceCanSearch) {
      return;
    }

    const query = installQuery.trim();
    if (query.length === 0) {
      searchSkills(marketplaceCategorySearchQuery);
      return;
    }

    const timer = setTimeout(() => {
      searchSkills(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [marketplaceSearchKey, installQuery, isMarketplaceView, marketplaceCanSearch, searchSkills, marketplaceCategorySearchQuery]);

  const handleInstall = useCallback(async (slug: string, version?: string) => {
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
  }, [installSkill, t, skillsDirPath]);
  const handleUninstall = useCallback(async (slug: string) => {
    try {
      await uninstallSkill(slug);
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      toast.error(t('toast.failedUninstall') + ': ' + String(err));
    }
  }, [uninstallSkill, t]);

  if (loading) {
    return (
      <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div data-testid="skills-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-10 pt-16">

        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-6 shrink-0 gap-4">
          <div>
            <h1 className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight">
              {t('title')}
            </h1>
            <p className="text-subtitle text-foreground/70 font-medium">
              {t('subtitle')}
            </p>
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
            className={cn(
              "mb-6 p-4 rounded-xl border flex items-center gap-3",
              gatewayBannerState === 'starting'
                ? "border-blue-500/40 bg-blue-500/10"
                : "border-yellow-500/50 bg-yellow-500/10",
            )}
          >
            <AlertCircle className={cn(
              "h-5 w-5",
              gatewayBannerState === 'starting'
                ? "text-blue-600 dark:text-blue-400"
                : "text-yellow-600 dark:text-yellow-400",
            )} />
            <span className={cn(
              "text-sm font-medium",
              gatewayBannerState === 'starting'
                ? "text-blue-700 dark:text-blue-400"
                : "text-yellow-700 dark:text-yellow-400",
            )}>
              {gatewayBannerState === 'starting' ? t('gatewayStarting') : t('gatewayWarning')}
            </span>
          </div>
        )}

        {/* Sub Navigation and Actions */}
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-black/10 dark:border-white/10 pb-4 mb-4 shrink-0 gap-4">
          <div className="flex items-center flex-wrap gap-2 text-sm">
            <div className="relative group flex items-center bg-black/5 dark:bg-white/5 rounded-full px-3 py-1.5 focus-within:bg-black/10 transition-colors border border-transparent focus-within:border-black/10 dark:focus-within:border-white/10 mr-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                placeholder={isMarketplaceView ? t('searchMarketplace') : t('search')}
                value={isMarketplaceView ? installQuery : searchQuery}
	                onChange={(e) => {
	                  if (isMarketplaceView) {
	                    setMarketplaceCategoryFilter('all');
	                    setInstallQuery(e.target.value);
	                  } else {
	                    setSearchQuery(e.target.value);
                  }
                }}
                className="ml-2 bg-transparent outline-none w-28 md:w-40 font-normal placeholder:text-foreground/50 text-meta text-foreground"
              />
              {(isMarketplaceView ? installQuery : searchQuery) && (
                <button
                  type="button"
	                  onClick={() => {
	                    if (isMarketplaceView) {
	                      setMarketplaceCategoryFilter('all');
	                      setInstallQuery('');
	                    } else {
                      setSearchQuery('');
                    }
                  }}
                  className="text-foreground/50 hover:text-foreground shrink-0 ml-1"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="skills-filter-enabled"
              onClick={() => handleStatusFilterClick('enabled')}
              className={cn(
                'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                !isMarketplaceView && statusFilter === 'enabled'
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
                !isMarketplaceView && statusFilter === 'disabled'
                  ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                  : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
              )}
            >
              {t('filter.disabledList', { count: disabledSkillsCount })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="skills-marketplace-button"
              disabled={!marketplaceCanSearch}
              title={marketplaceCanSearch ? undefined : t('marketplace.unavailable')}
              onClick={() => {
                if (!marketplaceCanSearch) return;
                setStatusFilter('all');
                setViewMode('marketplace');
              }}
              className={cn(
                'h-8 rounded-full px-3 text-meta font-medium border shadow-none',
                isMarketplaceView
                  ? 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 text-foreground'
                  : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
                !marketplaceCanSearch && 'cursor-not-allowed opacity-50 hover:bg-transparent dark:hover:bg-transparent',
              )}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t('actions.skillMarketplace')}
            </Button>
          </div>

        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {error && (
            <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>
                {FETCH_ERROR_CODES.has(error)
                  ? t(`toast.${error}`, { path: skillsDirPath })
                  : error}
              </span>
            </div>
          )}

          {isMarketplaceView ? (
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-black/10 bg-black/[0.02] px-4 py-4 text-sm text-foreground/70 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground">{t('marketplace.title')}</div>
                    <div className="mt-1 max-w-2xl text-meta leading-relaxed">
                      {marketSearchTerm
                        ? t('marketplace.searchSubtitle')
                        : marketplaceCanInstall
                          ? t('marketplace.homeSubtitle')
                          : t('marketplace.browseOnlyHomeSubtitle')}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <div className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 text-meta font-medium text-foreground dark:border-white/10 dark:bg-white/[0.06]">
                        <Layers3 className="h-3.5 w-3.5 text-foreground/55" />
                        <span>{marketplaceTotalCountLabel}</span>
                      </div>
                      <div className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 text-meta font-medium text-foreground dark:border-white/10 dark:bg-white/[0.06]">
                        <Package className="h-3.5 w-3.5 text-foreground/55" />
                        <span>{t('marketplace.loadedCount', { count: formatMarketplaceCount(marketplaceLoadedCount) })}</span>
                      </div>
                      <div className="inline-flex h-8 items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 text-meta font-medium text-foreground dark:border-white/10 dark:bg-white/[0.06]">
                        <Sparkles className="h-3.5 w-3.5 text-foreground/55" />
                        <span>{t('marketplace.scenarioCount', { count: marketplaceCategoryOptions.length - 1 })}</span>
                      </div>
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
                    {!marketplaceCanInstall && (
                      <div className="flex gap-2 text-amber-700 dark:text-amber-400">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{t('marketplace.installUnavailableDescription')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {searchError && (
                <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm font-medium text-destructive">
                  {SEARCH_ERROR_CODES.has(searchError.replace('Error: ', ''))
                    ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                    : searchError}
                </div>
              )}

              <div className="flex flex-col gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 px-1">
                    <span className="text-meta font-semibold text-foreground/80">
                      {t('marketplace.categoryFilterLabel')}
                    </span>
                    <span className="min-w-0 shrink text-right text-tiny text-muted-foreground">
                      {marketplaceTotalKnown && marketplaceCategoryFilter === 'all' && !marketSearchTerm
                        ? t('marketplace.totalAndLoadedCount', {
                          total: formatMarketplaceCount(marketplaceTotal),
                          loaded: formatMarketplaceCount(marketplaceLoadedCount),
                        })
                        : marketplaceLoadedCountLabel}
                    </span>
                  </div>
                  <div
                    role="list"
                    aria-label={t('marketplace.categoryFilterLabel')}
                    className="flex flex-wrap gap-2"
                  >
                    {marketplaceCategoryOptions.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid={`marketplace-category-${option.id}`}
                        onClick={() => handleMarketplaceCategoryClick(option.id)}
                        className={cn(
                          'h-8 rounded-full border px-3 text-meta font-medium shadow-none',
                          marketplaceCategoryFilter === option.id
                            ? 'border-black/10 bg-black/5 text-foreground dark:border-white/10 dark:bg-white/10'
                            : 'border-transparent bg-transparent text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5',
                        )}
                      >
                        <span className="truncate">{option.label}</span>
                      </Button>
                    ))}
                  </div>
                </div>

                {marketplaceCategoryResultPending || (searching && searchResults.length === 0) ? (
                  <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                    <LoadingSpinner size="lg" />
                    <p className="mt-4 text-sm">{t('marketplace.searching')}</p>
                  </div>
                ) : visibleMarketplaceSkills.length === 0 && !searchError ? (
                  <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                    <Package className="mb-4 h-10 w-10 opacity-50" />
                    <p>
                      {marketplaceCategoryFilter !== 'all' && !marketSearchTerm
                        ? t('marketplace.noCategoryResults')
                        : marketSearchTerm
                          ? t('marketplace.noResults')
                          : t('marketplace.emptyPrompt')}
                    </p>
                  </div>
                ) : visibleMarketplaceSkills.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleMarketplaceSkills.map((skill, index) => {
                      const skillSlug = resolveMarketplaceSkillSlug(skill);
                      return (
                        <MarketplaceSkillCard
                          key={skillSlug ?? `${skill.name}-${index}`}
                          skill={skill}
                          installedSkill={safeSkills.find((s) => (skillSlug && (s.id === skillSlug || s.slug === skillSlug)) || s.name === skill.name)}
                          installing={skillSlug ? !!installing[skillSlug] : false}
                          canInstall={marketplaceCanInstall}
                          onInstall={handleInstall}
                          onUninstall={handleUninstall}
                        />
                      );
                    })}
                  </div>
                ) : null}

                {marketplaceHasMore && visibleMarketplaceSkills.length > 0 && (
                  <div className="flex justify-center pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={searching}
                      onClick={() => void loadMoreMarketplaceSkills()}
                      className="h-9 rounded-full px-4 text-meta font-medium shadow-none"
                    >
                      {searching ? <LoadingSpinner size="sm" /> : t('marketplace.loadMore')}
                    </Button>
                  </div>
                )}
              </div>
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
                          {skill.isCore ? (
                            <Lock className="h-3 w-3 text-muted-foreground" />
                          ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-1 pr-6 leading-relaxed">
                          {skill.description}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-tiny text-foreground/55 min-w-0">
                          <Badge variant="secondary" className="shrink-0 whitespace-nowrap px-1.5 py-0 h-5 text-2xs font-medium bg-black/5 dark:bg-white/10 border-0 shadow-none">
                            {resolveSkillSourceLabel(skill, t)}
                          </Badge>
                          <span className="truncate font-mono min-w-0">
                            {skill.baseDir || t('detail.pathUnavailable')}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 shrink-0" onClick={e => e.stopPropagation()}>
                      {skill.version && (
                        <span className="text-meta font-mono text-muted-foreground">
                          v{skill.version}
                        </span>
                      )}
                      {canUninstallSkill(skill) && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleUninstall(skill.slug || skill.id)}
                          className="h-8 shadow-none"
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
