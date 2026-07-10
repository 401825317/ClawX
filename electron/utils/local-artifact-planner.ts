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

const LOCAL_ARTIFACT_PLANNER_TIMEOUT_MS = 18_000;
const MAX_BATCH_ITEMS = 8;
const MAX_TEXT_CHARS = 36_000;
const SINGLE_INITIAL_ARTIFACT_FAST_PATH_ERROR = 'artifact_planner_single_artifact_fast_path';

export type LocalArtifactPlanItem = {
  id: string;
  request: LocalArtifactCreateRequest;
  verificationFeedback?: {
    detail?: string;
    evidence?: string;
  };
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizePresentationColumns(value: unknown): NonNullable<NonNullable<LocalArtifactCreateRequest['slides']>[number]['columns']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const columns = value.slice(0, 2).map((entry) => {
    const item = record(entry);
    return {
      title: text(item.title, 120),
      body: text(item.body, 800),
      bullets: textArray(item.bullets, 5, 280),
    };
  }).filter((column) => column.title || column.body || (column.bullets?.length ?? 0) > 0);
  return columns.length === 2 ? columns : undefined;
}

function normalizePresentationMetrics(value: unknown): NonNullable<NonNullable<LocalArtifactCreateRequest['slides']>[number]['metrics']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const metrics = value.slice(0, 4).map((entry) => {
    const item = record(entry);
    const metricValue = typeof item.value === 'number' && Number.isFinite(item.value)
      ? item.value
      : text(item.value, 80);
    return {
      label: text(item.label, 100),
      value: metricValue,
      detail: text(item.detail, 240),
    };
  }).filter((metric) => metric.label && metric.value !== undefined);
  return metrics.length > 0 ? metrics : undefined;
}

function normalizePresentationTimeline(value: unknown): NonNullable<NonNullable<LocalArtifactCreateRequest['slides']>[number]['timeline']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const timeline = value.slice(0, 5).map((entry) => {
    const item = record(entry);
    return {
      period: text(item.period, 80),
      title: text(item.title, 120),
      body: text(item.body, 500),
    };
  }).filter((item) => item.period || item.title || item.body);
  return timeline.length > 0 ? timeline : undefined;
}

function normalizeSpreadsheetMetricValue(value: unknown): unknown {
  if (typeof value === 'string') return text(value, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return normalizeCell(value);
}

function normalizeSpreadsheetKeyMetrics(value: unknown): NonNullable<NonNullable<LocalArtifactCreateRequest['sheets']>[number]['keyMetrics']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const metrics = value.slice(0, 8).map((entry) => {
    const item = record(entry);
    return {
      label: text(item.label, 120),
      value: normalizeSpreadsheetMetricValue(item.value),
      detail: text(item.detail, 280),
    };
  }).filter((metric) => metric.label && metric.value !== undefined && metric.value !== '');
  return metrics.length > 0 ? metrics : undefined;
}

function normalizeConditionalFormatting(value: unknown): NonNullable<NonNullable<LocalArtifactCreateRequest['sheets']>[number]['conditionalFormatting']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules = value.slice(0, 8).map((entry) => {
    const item = record(entry);
    const column = typeof item.column === 'number' && Number.isInteger(item.column) && item.column >= 0
      ? item.column
      : text(item.column, 120);
    if (column === undefined) return undefined;
    const type = item.type === 'data-bar' || item.type === 'cell-is' ? item.type : 'color-scale';
    if (type !== 'cell-is') return { column, type };
    const validOperator = item.operator === 'greaterThan'
      || item.operator === 'greaterThanOrEqual'
      || item.operator === 'lessThan'
      || item.operator === 'lessThanOrEqual'
      || item.operator === 'equal'
      || item.operator === 'notEqual';
    if (!validOperator || typeof item.value !== 'number' || !Number.isFinite(item.value)) return undefined;
    return { column, type, operator: item.operator, value: item.value };
  }).filter((rule): rule is NonNullable<typeof rule> => Boolean(rule));
  return rules.length > 0 ? rules : undefined;
}

function normalizeSlides(value: unknown): LocalArtifactCreateRequest['slides'] {
  if (!Array.isArray(value)) return undefined;
  const slides = value.slice(0, 16).map((entry) => {
    const item = record(entry);
    const columns = normalizePresentationColumns(item.columns);
    const metrics = normalizePresentationMetrics(item.metrics);
    const timeline = normalizePresentationTimeline(item.timeline);
    const requestedLayout = item.layout === 'two-column' || item.layout === 'metric' || item.layout === 'timeline'
      ? item.layout
      : undefined;
    const layout = requestedLayout === 'two-column' && columns
      ? requestedLayout
      : requestedLayout === 'metric' && metrics
        ? requestedLayout
        : requestedLayout === 'timeline' && timeline
          ? requestedLayout
          : undefined;
    return {
      title: text(item.title, 160),
      subtitle: text(item.subtitle, 280),
      body: text(item.body, 1_600),
      bullets: textArray(item.bullets, 7, 360),
      ...(layout ? { layout } : {}),
      ...(columns ? { columns } : {}),
      ...(metrics ? { metrics } : {}),
      ...(timeline ? { timeline } : {}),
    };
  }).filter((slide) => (
    slide.title
    || slide.subtitle
    || slide.body
    || (slide.bullets?.length ?? 0) > 0
    || (slide.columns?.length ?? 0) > 0
    || (slide.metrics?.length ?? 0) > 0
    || (slide.timeline?.length ?? 0) > 0
  ));
  return slides.length > 0 ? slides : undefined;
}

function normalizeSheets(value: unknown): LocalArtifactCreateRequest['sheets'] {
  if (!Array.isArray(value)) return undefined;
  const sheets = value.slice(0, 4).map((entry, index) => {
    const item = record(entry);
    const headers = textArray(item.headers, 20, 120);
    const rows = Array.isArray(item.rows)
      ? item.rows.slice(0, 120).map((row) => (
          Array.isArray(row) ? row.slice(0, 20).map(normalizeCell) : [normalizeCell(row)]
        ))
      : undefined;
    const summary = text(item.summary, 1_200);
    const keyMetrics = normalizeSpreadsheetKeyMetrics(item.keyMetrics);
    const conditionalFormatting = normalizeConditionalFormatting(item.conditionalFormatting);
    return {
      name: text(item.name, 31) ?? `Sheet${index + 1}`,
      headers,
      rows,
      ...(summary ? { summary } : {}),
      ...(keyMetrics ? { keyMetrics } : {}),
      ...(conditionalFormatting ? { conditionalFormatting } : {}),
    };
  }).filter((sheet) => (
    (sheet.headers?.length ?? 0) > 0
    || (sheet.rows?.length ?? 0) > 0
    || Boolean(sheet.summary)
    || (sheet.keyMetrics?.length ?? 0) > 0
  ));
  return sheets.length > 0 ? sheets : undefined;
}

function normalizeSections(value: unknown): LocalArtifactCreateRequest['sections'] {
  if (!Array.isArray(value)) return undefined;
  const sections = value.slice(0, 12).map((entry, index) => {
    const item = record(entry);
    const paragraphs = textArray(item.paragraphs, 8, 2_000);
    const bullets = textArray(item.bullets, 12, 600);
    if ((paragraphs?.length ?? 0) === 0 && (bullets?.length ?? 0) === 0) return undefined;
    return {
      title: text(item.title, 160) ?? (index === 0 ? '正文' : `内容 ${index + 1}`),
      paragraphs,
      bullets,
    };
  }).filter((section): section is NonNullable<typeof section> => Boolean(section));
  return sections.length > 0 ? sections : undefined;
}

function hasExecutablePresentationContent(request: LocalArtifactCreateRequest): boolean {
  return (request.slides ?? []).some((slide) => (
    Boolean(text(slide.subtitle, 280) || text(slide.body, 1_600))
    || (slide.bullets ?? []).some((bullet) => Boolean(text(bullet, 360)))
    || (slide.columns ?? []).some((column) => (
      Boolean(text(column.body, 800))
      || (column.bullets ?? []).some((bullet) => Boolean(text(bullet, 280)))
    ))
    || (slide.metrics ?? []).some((metric) => Boolean(text(metric.detail, 240)))
    || (slide.timeline ?? []).some((entry) => Boolean(text(entry.body, 500)))
  ));
}

function hasExecutableSpreadsheetContent(request: LocalArtifactCreateRequest): boolean {
  return (request.sheets ?? []).some((sheet) => (
    (sheet.rows ?? []).some((row) => row.some((cell) => cell !== undefined && cell !== null && cell !== ''))
    || (sheet.keyMetrics?.length ?? 0) > 0
  ));
}

function hasExecutableMiniProgramContent(request: LocalArtifactCreateRequest): boolean {
  const html = text(request.html);
  if (html && /<(?:button|input|select|textarea|form)\b/iu.test(html) && /<script\b/iu.test(html)) return true;
  return Boolean(text(request.body) && text(request.js));
}

function hasExecutableCopywritingContent(request: LocalArtifactCreateRequest): boolean {
  const bodyLines = [
    text(request.content),
    ...(request.sections ?? []).flatMap((section) => [
      ...(section.paragraphs ?? []).map((paragraph) => text(paragraph, 2_000)),
      ...(section.bullets ?? []).map((bullet) => text(bullet, 600)),
    ]),
  ].filter((line): line is string => Boolean(line && line.length >= 10));
  const bodyChars = bodyLines.join(' ').length;
  return bodyLines.length >= 2 || bodyChars >= 160;
}

function hasExecutablePlan(request: LocalArtifactCreateRequest): boolean {
  if (request.kind === 'presentation') return hasExecutablePresentationContent(request);
  if (request.kind === 'spreadsheet') return hasExecutableSpreadsheetContent(request);
  if (request.kind === 'mini_program') return hasExecutableMiniProgramContent(request);
  return hasExecutableCopywritingContent(request);
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

function hasVerificationFeedback(item: LocalArtifactPlanItem): boolean {
  return Boolean(text(item.verificationFeedback?.detail, 4_000) || text(item.verificationFeedback?.evidence, 8_000));
}

function executionFingerprint(request: LocalArtifactCreateRequest): string {
  const executionRequest = { ...request };
  delete executionRequest.planningMode;
  delete executionRequest.planningSummary;
  return JSON.stringify(executionRequest);
}

function fallbackRequest(item: LocalArtifactPlanItem, error: string): LocalArtifactCreateRequest {
  const request = { ...item.request };
  const detail = text(item.verificationFeedback?.detail, 4_000);
  const evidence = text(item.verificationFeedback?.evidence, 8_000);
  if (!detail && !evidence) {
    const hasPrompt = Boolean(request.sourcePrompt?.trim() || request.originalPrompt?.trim() || request.title?.trim());
    return {
      ...request,
      planningMode: hasPrompt ? 'prompt-heuristic' : 'fallback-template',
      planningSummary: `模型规划不可用，使用本地可执行保底规划（${error}）。`,
    };
  }

  delete request.slides;
  delete request.sheets;
  delete request.content;
  delete request.sections;
  delete request.html;
  delete request.body;
  delete request.css;
  delete request.js;
  const originalPrompt = item.request.originalPrompt?.trim()
    || item.request.sourcePrompt?.trim()
    || item.request.title?.trim()
    || '重新生成本地产物';
  request.sourcePrompt = [
    originalPrompt,
    '上一次生成的本地产物内容验证未通过，必须重新规划并修复实际内容，不能复用原计划。',
    detail ? `验证详情：${detail}` : '',
    evidence ? `验证证据：${evidence}` : '',
  ].filter(Boolean).join('\n');
  request.planningMode = 'prompt-heuristic';
  request.planningSummary = `模型修复规划不可用，已根据验证反馈生成新的本地可执行保底规划（${error}）。`;
  return request;
}

function plannedOrFallbackRequest(
  item: LocalArtifactPlanItem,
  rawPlan: Record<string, unknown> | undefined,
  fallbackError: string,
): LocalArtifactCreateRequest {
  if (!rawPlan) return fallbackRequest(item, fallbackError);
  const planned = normalizePlannedRequest(item.request, rawPlan);
  if (!hasExecutablePlan(planned)) {
    return fallbackRequest(item, 'artifact_planner_non_executable_plan');
  }
  if (
    hasVerificationFeedback(item)
    && executionFingerprint(planned) === executionFingerprint(item.request)
  ) {
    return fallbackRequest(item, 'artifact_planner_unchanged_retry');
  }
  return planned;
}

function plannerMessages(items: LocalArtifactPlanItem[]): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是 UClaw 的产物内容规划器。只返回严格 JSON，不解释，不使用 Markdown 代码块。',
        '一次为多个产物做统一主题但各自独立可交付的内容计划，不能返回空泛模板。',
        '返回 {"items":[...]}，每项保留 id、kind，并提供 title、summary。',
        'presentation: 提供 slides，每页含 title 及 bullets/body；页数和章节必须遵守用户要求，内容具体、有数据感、避免重复标题。可选丰富字段：layout 只能是 two-column/metric/timeline；two-column 搭配恰好 2 个 columns（title/body/bullets），metric 搭配 metrics（label/value/detail），timeline 搭配 timeline（period/title/body）。',
        'spreadsheet: 提供 sheets，每张含 name、headers、rows；需要计算时，单元格使用 {"formula":"SUM(B2:B5)","value":0}，公式不带等号。可选丰富字段：summary、keyMetrics（label/value/detail）、conditionalFormatting（column、type=color-scale/data-bar/cell-is；cell-is 还需 operator 和数值 value）。',
        'mini_program: 提供 body、css、js，必须是可直接运行的交互页面；实现用户要求的新增、删除、筛选、搜索、校验、持久化等实际行为。',
        'copywriting: 提供 content 或 sections；sections 的每一项必须包含 paragraphs 或 bullets，禁止只返回标题；正文至少包含 2 条实质内容或 160 个字符，并匹配主题、受众和用途，不写系统能力说明。',
        '出现 verification_feedback 时，必须基于 previous_planned_request 重新规划，直接修复 detail/evidence 指出的问题，并实质替换会影响产物的内容或结构，禁止原样返回。',
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
          ...(hasVerificationFeedback(item) ? {
            previous_planned_request: item.request,
            verification_feedback: {
              detail: text(item.verificationFeedback?.detail, 4_000),
              evidence: text(item.verificationFeedback?.evidence, 8_000),
            },
          } : {}),
        })),
      }),
    },
  ];
}

function fallback(items: LocalArtifactPlanItem[], startedAt: number, error: string): LocalArtifactBatchPlanResult {
  return {
    source: 'fallback',
    durationMs: Date.now() - startedAt,
    items: items.map((item) => ({ id: item.id, request: fallbackRequest(item, error) })),
    error,
  };
}

function shouldUseSingleInitialArtifactFastPath(items: LocalArtifactPlanItem[]): boolean {
  if (items.length !== 1) return false;
  const [item] = items;
  if (!item || hasVerificationFeedback(item)) return false;
  return isLocalArtifactKind(item.request.kind);
}

export async function planLocalArtifactBatch(rawItems: LocalArtifactPlanItem[]): Promise<LocalArtifactBatchPlanResult> {
  const startedAt = Date.now();
  const items = rawItems
    .filter((item) => item.id?.trim() && item.request && typeof item.request === 'object')
    .map((item) => ({
      id: item.id.trim(),
      request: item.request,
      ...(item.verificationFeedback ? {
        verificationFeedback: {
          detail: text(item.verificationFeedback.detail, 4_000),
          evidence: text(item.verificationFeedback.evidence, 8_000),
        },
      } : {}),
    }));
  if (items.length === 0) return fallback([], startedAt, 'artifact_planner_empty_batch');
  if (shouldUseSingleInitialArtifactFastPath(items)) {
    logger.info('[local-artifact-planner] single_initial_fast_path', {
      durationMs: Date.now() - startedAt,
      kind: items[0]!.request.kind,
    });
    return fallback(items, startedAt, SINGLE_INITIAL_ARTIFACT_FAST_PATH_ERROR);
  }
  const modelItems = items.slice(0, MAX_BATCH_ITEMS);

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
          messages: plannerMessages(modelItems),
          temperature: 0.25,
          reasoning_effort: 'low',
          max_tokens: Math.min(6_000, Math.max(2_400, modelItems.length * 1_400)),
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
        return {
          id: item.id,
          request: plannedOrFallbackRequest(
            item,
            rawPlan,
            modelItems.includes(item) ? 'artifact_planner_missing_item' : 'artifact_planner_batch_limit',
          ),
        };
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
