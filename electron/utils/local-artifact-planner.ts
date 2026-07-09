import { getProviderAccount } from '../services/providers/provider-store';
import { getProviderSecret } from '../services/secrets/secret-store';
import {
  getJunFeiAIProviderBaseUrl,
  JUNFEIAI_DEFAULT_MODEL,
  JUNFEIAI_PROVIDER_ID,
} from './junfeiai-distribution';
import type { LocalArtifactCreateRequest, LocalArtifactKind } from './local-artifact-runtime';
import { logger } from './logger';
import { proxyAwareFetch } from './proxy-fetch';

const LOCAL_ARTIFACT_PLANNER_TIMEOUT_MS = 45_000;
const MAX_BATCH_ITEMS = 8;
const MAX_TEXT_CHARS = 36_000;

export type LocalArtifactPlanItem = {
  id: string;
  request: LocalArtifactCreateRequest;
};

export type LocalArtifactBatchPlanResult = {
  source: 'model' | 'fallback';
  durationMs: number;
  items: LocalArtifactPlanItem[];
  error?: string;
};

function getApiKey(secret: Awaited<ReturnType<typeof getProviderSecret>>): string | null {
  if (!secret) return null;
  if (secret.type === 'api_key' && secret.apiKey?.trim()) return secret.apiKey.trim();
  if (secret.type === 'local' && secret.apiKey?.trim()) return secret.apiKey.trim();
  return null;
}

function toChatCompletionsEndpoint(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/u, '');
  if (!normalized) normalized = getJunFeiAIProviderBaseUrl().replace(/\/+$/u, '');
  if (/\/chat\/completions$/iu.test(normalized)) return normalized;
  if (/\/responses?$/iu.test(normalized)) return normalized.replace(/\/responses?$/iu, '/chat/completions');
  if (!/\/v1$/iu.test(normalized)) normalized = `${normalized}/v1`;
  return `${normalized}/chat/completions`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function textArray(value: unknown, maxItems = 12, maxChars = 800): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => text(item, maxChars))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
  return items.length > 0 ? items : undefined;
}

function normalizeCell(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 2_000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value == null) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return String(value).slice(0, 2_000);
  const record = value as Record<string, unknown>;
  const formula = text(record.formula, 500)?.replace(/^=/u, '');
  if (!formula) return text(record.value, 2_000) ?? '';
  const fallbackValue = typeof record.value === 'number' && Number.isFinite(record.value)
    ? record.value
    : undefined;
  return { formula, ...(fallbackValue !== undefined ? { value: fallbackValue } : {}) };
}

function normalizeSlides(value: unknown): LocalArtifactCreateRequest['slides'] {
  if (!Array.isArray(value)) return undefined;
  const slides = value.slice(0, 16).map((entry) => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    return {
      title: text(record.title, 160),
      subtitle: text(record.subtitle, 280),
      body: text(record.body, 1_600),
      bullets: textArray(record.bullets, 7, 360),
    };
  }).filter((slide) => slide.title || slide.subtitle || slide.body || (slide.bullets?.length ?? 0) > 0);
  return slides.length > 0 ? slides : undefined;
}

function normalizeSheets(value: unknown): LocalArtifactCreateRequest['sheets'] {
  if (!Array.isArray(value)) return undefined;
  const sheets = value.slice(0, 4).map((entry, index) => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    const headers = textArray(record.headers, 20, 120);
    const rows = Array.isArray(record.rows)
      ? record.rows.slice(0, 120).map((row) => (
          Array.isArray(row) ? row.slice(0, 20).map(normalizeCell) : [normalizeCell(row)]
        ))
      : undefined;
    return {
      name: text(record.name, 31) ?? `Sheet${index + 1}`,
      headers,
      rows,
    };
  }).filter((sheet) => (sheet.headers?.length ?? 0) > 0 || (sheet.rows?.length ?? 0) > 0);
  return sheets.length > 0 ? sheets : undefined;
}

function normalizeSections(value: unknown): LocalArtifactCreateRequest['sections'] {
  if (!Array.isArray(value)) return undefined;
  const sections = value.slice(0, 12).map((entry) => {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : {};
    return {
      title: text(record.title, 160),
      paragraphs: textArray(record.paragraphs, 8, 2_000),
      bullets: textArray(record.bullets, 12, 600),
    };
  }).filter((section) => section.title || (section.paragraphs?.length ?? 0) > 0 || (section.bullets?.length ?? 0) > 0);
  return sections.length > 0 ? sections : undefined;
}

function normalizePlannedRequest(
  original: LocalArtifactCreateRequest,
  raw: Record<string, unknown>,
): LocalArtifactCreateRequest {
  const common = {
    ...original,
    title: text(raw.title, 180) ?? original.title,
    planningMode: 'model' as const,
    planningSummary: text(raw.summary, 500) ?? '已由当前文本模型生成结构化内容计划。',
  };
  if (original.kind === 'presentation') {
    return { ...common, slides: normalizeSlides(raw.slides) };
  }
  if (original.kind === 'spreadsheet') {
    return { ...common, sheets: normalizeSheets(raw.sheets) };
  }
  if (original.kind === 'mini_program') {
    return {
      ...common,
      html: text(raw.html),
      body: text(raw.body),
      css: text(raw.css),
      js: text(raw.js),
    };
  }
  return {
    ...common,
    content: text(raw.content),
    sections: normalizeSections(raw.sections),
  };
}

function plannerMessages(items: LocalArtifactPlanItem[]): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是 UClaw 的产物内容规划器。只返回严格 JSON，不解释，不使用 Markdown 代码块。',
        '一次为多个产物做统一主题但各自独立可交付的内容计划，不能返回空泛模板。',
        '返回 {"items":[...]}，每项保留 id、kind，并提供 title、summary。',
        'presentation: 提供 slides，每页含 title 及 bullets/body；页数和章节必须遵守用户要求，内容具体、有数据感、避免重复标题。',
        'spreadsheet: 提供 sheets，每张含 name、headers、rows；需要计算时，单元格使用 {"formula":"SUM(B2:B5)","value":0}，公式不带等号。',
        'mini_program: 提供 body、css、js，必须是可直接运行的交互页面；实现用户要求的新增、删除、筛选、搜索、校验、持久化等实际行为。',
        'copywriting: 提供 content 或 sections；文案要匹配主题、受众和用途，不写系统能力说明。',
        '没有指定主题时，为整批随机样例选择一个清晰、可视觉化的统一主题。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        items: items.map((item) => ({
          id: item.id,
          kind: item.request.kind,
          title: item.request.title,
          prompt: item.request.sourcePrompt || item.request.originalPrompt || item.request.title || '',
          batch_context: item.request.originalPrompt || '',
        })),
      }),
    },
  ];
}

function fallback(items: LocalArtifactPlanItem[], startedAt: number, error: string): LocalArtifactBatchPlanResult {
  return { source: 'fallback', durationMs: Date.now() - startedAt, items, error };
}

export async function planLocalArtifactBatch(rawItems: LocalArtifactPlanItem[]): Promise<LocalArtifactBatchPlanResult> {
  const startedAt = Date.now();
  const items = rawItems
    .filter((item) => item.id?.trim() && item.request && typeof item.request === 'object')
    .slice(0, MAX_BATCH_ITEMS)
    .map((item) => ({ id: item.id.trim(), request: item.request }));
  if (items.length === 0) return fallback([], startedAt, 'artifact_planner_empty_batch');

  try {
    const secret = await getProviderSecret(JUNFEIAI_PROVIDER_ID);
    const apiKey = getApiKey(secret);
    if (!apiKey) return fallback(items, startedAt, 'artifact_planner_api_key_unavailable');
    const account = await getProviderAccount(JUNFEIAI_PROVIDER_ID);
    const endpoint = toChatCompletionsEndpoint(account?.baseUrl || getJunFeiAIProviderBaseUrl());
    const model = account?.model?.trim() || JUNFEIAI_DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_ARTIFACT_PLANNER_TIMEOUT_MS);
    try {
      const response = await proxyAwareFetch(endpoint, {
        method: 'POST',
        headers: {
          ...(account?.headers ?? {}),
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: plannerMessages(items),
          temperature: 0.25,
          max_tokens: 9_000,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return fallback(items, startedAt, `artifact_planner_http_${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? parseJsonObject(content) : null;
      const rawPlans = Array.isArray(parsed?.items) ? parsed.items : [];
      const rawById = new Map<string, Record<string, unknown>>();
      for (const rawPlan of rawPlans) {
        if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) continue;
        const record = rawPlan as Record<string, unknown>;
        const id = text(record.id, 200);
        if (id) rawById.set(id, record);
      }
      const plannedItems = items.map((item) => {
        const rawPlan = rawById.get(item.id);
        return rawPlan
          ? { id: item.id, request: normalizePlannedRequest(item.request, rawPlan) }
          : item;
      });
      const modelPlanCount = plannedItems.filter((item) => item.request.planningMode === 'model').length;
      if (modelPlanCount === 0) return fallback(items, startedAt, 'artifact_planner_invalid_json');
      logger.info('[local-artifact-planner] planned', {
        durationMs: Date.now() - startedAt,
        itemCount: items.length,
        modelPlanCount,
        kinds: items.map((item) => item.request.kind),
      });
      return { source: 'model', durationMs: Date.now() - startedAt, items: plannedItems };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[local-artifact-planner] fallback', { durationMs: Date.now() - startedAt, error: message });
    return fallback(items, startedAt, message);
  }
}

export function isLocalArtifactKind(value: unknown): value is LocalArtifactKind {
  return value === 'presentation' || value === 'spreadsheet' || value === 'mini_program' || value === 'copywriting';
}
