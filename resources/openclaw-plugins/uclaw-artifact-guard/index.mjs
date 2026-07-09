import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

const PLUGIN_ID = 'uclaw-artifact-guard';
const REVISION_ID = `${PLUGIN_ID}:artifact-delivery`;
const REVISION_REASON = 'UClaw artifact delivery final reply had no completed artifact evidence.';
const PROMPT_CONTEXT_HOOK_ID = `${PLUGIN_ID}:artifact-delivery-context`;
const MEDIA_INTENT_TOOL_GATE_HOOK_ID = `${PLUGIN_ID}:media-intent-tool-gate`;
const RUNTIME_EVENT_SOURCE = PLUGIN_ID;
let runtimeEventSeq = 0;
const PROMPT_CONTEXT = [
  'UClaw 交付与语言规则：',
  '- 如果最新用户消息是内部心跳 `[OpenClaw heartbeat poll]`，必须只回复 `HEARTBEAT_OK`，不能继续、评价、补做或复述任何历史任务。',
  '- 默认所有面向用户的自然语言回复必须使用简体中文；不要因为工具、技能、日志、模板或上一次回复是英文而切换成英文。',
  '- 用户要求生成、创建、导出、美化或打开 PPT/PPTX、Word/DOCX、Excel/XLSX、PDF、文档、报告、表格、图片、网页、脚本或压缩包时，必须交付真实本地产物，不能只回复计划、承诺、大纲或说明。',
  '- 用户对上一轮已生成的产物给出负反馈或修改意图（例如太丑、不满意、不行、重做、换一版、美化、优化）时，应视为新的产物修订任务：必须直接制作一个新的非覆盖改进版，不能只评价或承诺。',
  '- 如果专用产物工具不可用，继续使用可用的 skill、exec、Node、Python 或 uv 路径创建文件；只有完成并验证、遇到具体阻塞点、或需要用户确认时才能结束。',
  '- 文件任务最终回复必须包含 MEDIA:<absolute-path> 或已验证的绝对文件路径。',
  '- 旧的 uclaw-computer-use 插件不属于可靠执行面；不要把启用它当作恢复路径，也不要假装存在 computer_* 桌面工具。',
  '- 用户要求打开/操作微信、QQ、钉钉、飞书、本机浏览器或其他本地应用并发送外部消息时，只有在当前工具清单存在可靠结构化 connector 且已经得到工具成功证据后，才能说“已发送/已打开”。',
  '- 如果没有可靠 connector，必须用简体中文说明具体能力缺失或阻塞点，可以给出消息草稿，但不能声称已经操作桌面或发出消息。',
].join('\n');

const MEDIA_INTENT_GATE_TIMEOUT_MS = 8_000;
const MEDIA_INTENT_GATE_TTL_MS = 10 * 60 * 1000;
const MEDIA_SIDE_EFFECT_TOOLS = new Set(['image_generate', 'video_generate']);
const SAFE_MEDIA_TOOL_ACTIONS = new Set(['list', 'status', 'get', 'inspect', 'describe', 'models', 'model', 'info', 'help']);
const mediaIntentGateByRunId = new Map();
const mediaIntentGateBySessionKey = new Map();

const ARTIFACT_REQUEST_RE = /(?:(?:做|制作|生成|创建|输出|导出|整理成|写|编写|起草|出|弄|做个|做一份|生成一份|创建一份).{0,40}(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|脚本|代码文件|压缩包|zip)|(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|脚本|代码文件|压缩包|zip).{0,40}(?:做|制作|生成|创建|输出|导出|整理|编写|起草|成稿|成品)|(?:create|make|generate|build|produce|export|write).{0,50}(?:file|document|report|proposal|bid|tender|presentation|slides?|pptx?|docx?|xlsx?|spreadsheet|pdf|image|video|html|script|zip))/iu;
const PAGE_ARTIFACT_RE = /(?:做|生成|写|编写|起草).{0,20}\d+\s*(?:页|page|pages).{0,20}(?:文档|报告|标书|投标书|招投标书|方案|Word|docx?|PDF|pdf)?/iu;
const ARTIFACT_CAPABILITY_TARGET_RE = /(?:文件(?:类)?产物|文件|文档|报告|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|小程序|代码文件|压缩包|zip|产物|artifact|file|document|report|presentation|slides?|spreadsheet|image|video|webpage|mini[-\s]?app)/iu;
const ARTIFACT_CAPABILITY_QUESTION_RE = /(?:能做哪些|可以做哪些|支持哪些|支持生成哪些|能生成哪些|能创建哪些|能产出哪些|可以生成哪些|可以创建哪些|能(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|可以(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|支持(?:什么|哪些|哪类|哪种)|有哪些(?:能力|功能|文件|产物|类型|格式)|有什么(?:能力|功能)|能力(?:范围|列表|介绍)|(?:能|可以)做吗|能不能做|支不支持|what can you|which .{0,40} can|can you|support(?:ed)?|capabilit)/iu;
const ARTIFACT_CREATE_COMMAND_RE = /(?:(?:帮我|给我|替我|直接).{0,20}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出)|(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|(?:create|make|generate|build|produce|export|write)\s+(?:a|an|one|some|the)\b)/iu;
const ARTIFACT_REVISION_FEEDBACK_RE = /(?:太丑|丑|难看|不好看|不满意|不行|不对|太差|太简陋|占位|模板感|不够.{0,12}(?:高级|好看|精致|正式|苹果|产品|宣传)|重新(?:做|制作|生成|来|搞)|重做|再做|再来|换一版|改一版|美化|优化|润色|升级|高级一点|好看一点|精致一点|重新直接制作|make it better|too ugly|ugly|not good|redo|remake|regenerate|make another|improve|polish)/iu;
const ARTIFACT_REVISION_NEGATION_RE = /(?:不要|别|不用|先别|无需|不需要|do not|don't|no need).{0,12}(?:重做|重新|修改|改|美化|优化|生成|制作|redo|remake|regenerate|improve|polish)/iu;
const HEARTBEAT_POLL_RE = /^\s*\[OpenClaw heartbeat poll\]\s*$/iu;
const HEARTBEAT_OK_RE = /^\s*HEARTBEAT_OK\s*$/iu;
const PROMISE_ONLY_RE = /(?:(?:^|[。！？!?；;\n\r]\s*)(?:好(?:的)?[，,。\\s]*)?(?:我(?:会|将|来|准备|可以|马上|先|接下来|现在|继续|直接|随后|稍后)|(?:接下来|下一步|随后|稍后|现在|马上|继续).{0,12}(?:我)?(?:会|将|来|准备|可以|马上|先|继续|直接)?|I(?:'ll| will| can| am going to)|Next(?:,| I)|I can).{0,180}(?:重做|重新(?:做|制作|生成|校验|验证|测试|检查)|生成|创建|制作|编写|起草|输出|整理|排版|导出|处理|完成|修(?:复|掉|正|改)?|修改|调整|补(?:做|齐|上)|校验|验证|测试|检查|make|create|generate|write|produce|export|redo|remake|regenerate|improve|polish|fix|repair|validate|verify|test|continue))/iu;
const ARTIFACT_REPAIR_PROMISE_CUE_RE = /(?:发现.{0,80}(?:问题|不对|不符合|未通过|失败|bug|错误)|实际.{0,40}(?:生成|只有|多了|少了|不符合)|(?:多了|少了|额外).{0,30}(?:页|项|个|张|条)|首屏可见|验证未通过|校验未通过|测试未通过|不符合(?:交互|预期|要求)|空页|页数不(?:对|符)|公式(?:缺失|错误)|交互(?:异常|错误)|bug|错误)/iu;
const CONTINUATION_RE = /(?:我(?:会|将|准备|打算|可以|马上|先|来)|接下来|下一步|随后|稍后|now I|I(?:'ll| will| can| am going to)|next)/iu;
const ARTIFACT_EXT = 'pptx?|docx?|xlsx?|pdf|csv|tsv|md|html?|json|zip|png|jpe?g|webp|svg|txt|py|js|ts|tsx|jsx|css|mp4|mov|webm';
const ARTIFACT_EVIDENCE_RE = new RegExp(`(?:MEDIA:\\s*(?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+|(?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})\\b|https?://[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})\\b|(?:filePath|outputPath|output_path|mediaUrl|media_url|url)["']?\\s*:\\s*["'][^"']+|(?:^|[\\s"'\`])out["']?\\s*:\\s*["'][^"']+)`, 'iu');
const MEDIA_ARTIFACT_PATH_RE = new RegExp(`MEDIA:\\s*((?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_PATH_RE = new RegExp(`((?:[A-Za-z]:[\\\\/]|/|~/|\\.\\.?/)[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_URL_RE = new RegExp(`(https?://[^\\s\`"'<>]+\\.(?:${ARTIFACT_EXT})(?:\\?[^\\s\`"'<>]+)?)`, 'giu');
const ARTIFACT_FIELD_RE = /(?:filePath|outputPath|output_path|mediaUrl|media_url|url|path|out)["']?\s*:\s*["']([^"']+)["']/giu;
const BLOCKER_RE = /(?:无法|不能|失败|报错|缺少|没有可用|找不到|不存在|权限|需要(?:你|用户).{0,24}(?:确认|提供|授权)|请(?:你|用户).{0,24}(?:确认|提供|授权)|blocked|cannot|can't|failed|missing|permission|not found|need you to)/iu;
const DESKTOP_ACTION_REQUEST_RE = /(?:(?:打开|启动|操作|控制|点击|输入|切换|关闭).{0,36}(?:微信|WeChat|企业微信|QQ|钉钉|飞书|本地应用|桌面应用|客户端|窗口|本机浏览器|Chrome|Edge)|(?:给|向).{0,48}(?:群|好友|联系人|会话|频道).{0,36}(?:发|发送|转发)|(?:发|发送).{0,36}(?:微信|消息|群消息|私信)|(?:open|launch|control|operate|send).{0,80}(?:WeChat|desktop app|native app|local app|message|group))/iu;
const STRUCTURED_CONNECTOR_TOOL_RE = /(?:\[tool:(?:message|directory|wechat|openclaw-weixin|channel)[^\]]*\]|toolName["']?\s*:\s*["'](?:message|directory|wechat|openclaw-weixin|channel)|"name"\s*:\s*"(?:message|directory|wechat|openclaw-weixin|channel)")/iu;
const STRUCTURED_CONNECTOR_SUCCESS_RE = /(?:success["']?\s*:\s*true|status["']?\s*:\s*["']?(?:ok|sent|success|completed)|已(?:经)?(?:发送|发出|投递|完成)|发送成功|sent|delivered|completed)/iu;
const PRODUCER_TOOL_RE = /(?:^|[_-])(?:create|write|edit|generate|export|render|save|screenshot|capture|record)(?:$|[_-])|(?:pptx|docx|xlsx|pdf|image|video|artifact|media)/iu;
const GENERATED_ARTIFACT_CUE_RE = /(?:MEDIA:|filePath|outputPath|artifact|saved|wrote|created|generated|exported|rendered|已生成|已保存|已导出|已创建|写入|产物)/iu;
const TOOL_ERROR_STATUS_RE = /^(?:error|failed|failure|blocked)$/iu;
const COMPOSITE_CONTRACT_RE = /【UClaw composite execution contract】|这是一个组合任务|子任务清单：/iu;
const COMPOSITE_TASK_RE = /^\s*\d+\.\s+\[[^\]]+\]\s+.+$/gmu;
const COMPOSITE_REQUIRED_ARTIFACT_RE = /产物要求：必须为这个子任务生成一个可见、可追踪的产物/gu;
const RAW_COMPOSITE_STRONG_CUE_RE = /(?:每(?:个|项|件|类|种)(?:事儿|事情|任务|产物)?|每个事儿|各(?:来|做|生成|出)|分别|都(?:随便)?(?:给我)?(?:来|做|生成|出)|一套|组合任务|多个|多种|全都|全部)/iu;
const RAW_COMPOSITE_SEPARATOR_RE = /[，、,；;]|(?:\s+(?:和|以及|还有|并且)\s*)/u;
const RAW_COMPOSITE_ARTIFACT_DETECTORS = [
  {
    id: 'image-generation',
    kind: 'image',
    title: '图片生成',
    pattern: /(?:生图|生成.{0,12}(?:图片|图像|海报|插画|封面)|(?:图片|图像|海报|插画|封面).{0,12}(?:生成|制作|做))/iu,
  },
  {
    id: 'presentation',
    kind: 'presentation',
    title: '演示文稿',
    pattern: /(?:PPT|pptx?|演示文稿|幻灯片|deck|slides?)/iu,
  },
  {
    id: 'spreadsheet',
    kind: 'spreadsheet',
    title: '表格',
    pattern: /(?:Excel|xlsx?|电子表格|工作簿|spreadsheet|workbook)/iu,
  },
  {
    id: 'video-generation',
    kind: 'video',
    title: '视频生成',
    pattern: /(?:生视频|生成.{0,12}视频|视频.{0,12}(?:生成|制作|做)|video)/iu,
  },
  {
    id: 'image-edit',
    kind: 'image',
    title: '图片编辑',
    pattern: /(?:(?:根据|用|拿|基于).{0,12}(?:图片|图像|照片).{0,18}(?:修图|改图|编辑|美化|处理)|(?:修图|改图|图片编辑|图像编辑|美化图片|图片处理|image edit))/iu,
  },
  {
    id: 'mini-app',
    kind: 'webpage',
    title: '小程序或网页',
    pattern: /(?:(?:做|制作|生成|创建|开发|写|搭).{0,16}(?:小程序|网页|HTML|应用|app|工具|小游戏|页面)|(?:小程序|网页|HTML|应用|app|工具|小游戏|页面).{0,16}(?:做|制作|生成|创建|开发|写|搭))/iu,
  },
  {
    id: 'copywriting',
    kind: 'document',
    title: '文案',
    pattern: /(?:(?:生成|写|出|产出|起草|创作).{0,16}(?:文案|copy|宣传语|广告语|稿子|短文|内容)|(?:文案|copy|宣传语|广告语|稿子|短文|内容).{0,16}(?:生成|写|出|产出|起草|创作))/iu,
  },
];

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.name === 'string' && part.type === 'toolCall') return `[tool:${part.name}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [extractTextFromContent(message.content)];
  for (const key of ['text', 'output', 'result']) {
    if (typeof message[key] === 'string') parts.push(message[key]);
  }
  if (message.details && typeof message.details === 'object') {
    try {
      parts.push(JSON.stringify(message.details));
    } catch {
      // ignore
    }
  }
  return parts.filter(Boolean).join('\n');
}

function extractMessageLists(event) {
  return [
    event?.messages,
    event?.messagesSnapshot,
    event?.finalMessages,
    event?.transcript,
    event?.conversation,
  ].filter(Array.isArray);
}

function extractUserRequestText(event) {
  const direct = [
    event?.userMessage,
    event?.userText,
    event?.prompt,
    event?.finalPromptText,
  ].filter((value) => typeof value === 'string').join('\n');

  const userMessages = extractMessageLists(event)
    .flatMap((messages) => messages)
    .filter((message) => message && typeof message === 'object' && message.role === 'user')
    .map(extractMessageText);

  return [direct, ...userMessages].filter(Boolean).join('\n');
}

function latestUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === 'object' && message.role === 'user') {
      return index;
    }
  }
  return -1;
}

function extractLatestUserRequestText(event) {
  const direct = [
    event?.userMessage,
    event?.userText,
    event?.prompt,
    event?.finalPromptText,
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n');
  if (direct.trim()) return direct;

  for (const messages of extractMessageLists(event)) {
    const index = latestUserMessageIndex(messages);
    if (index >= 0) {
      const text = extractMessageText(messages[index]);
      if (text.trim()) return text;
    }
  }
  return '';
}

function splitEventMessagesAroundLatestUser(event) {
  const before = [];
  const after = [];
  for (const messages of extractMessageLists(event)) {
    const index = latestUserMessageIndex(messages);
    if (index < 0) continue;
    before.push(...messages.slice(0, index));
    after.push(...messages.slice(index + 1));
  }
  return {
    before: { ...event, messages: before },
    after: { ...event, messages: after },
  };
}

function extractFinalAssistantText(event) {
  const direct = [event?.finalText, event?.assistantText, event?.lastAssistantMessage]
    .filter((value) => typeof value === 'string')
    .join('\n');
  if (direct.trim()) return direct;

  for (const messages of extractMessageLists(event)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && typeof message === 'object' && message.role === 'assistant') {
        const text = extractMessageText(message);
        if (text.trim()) return text;
      }
    }
  }
  return '';
}

function eventId(event, ctx) {
  return [
    event?.runId,
    ctx?.runId,
    event?.sessionId,
    ctx?.sessionId,
    event?.sessionKey,
    ctx?.sessionKey,
    event?.messageId,
  ].filter((value) => typeof value === 'string' && value.trim()).join('|') || 'unknown';
}

function logDiagnostic(label, payload) {
  try {
    console.warn(`[uclaw-artifact-guard] ${label} ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`[uclaw-artifact-guard] ${label}`);
  }
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedText(value, maxChars = 600) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function normalizePlannerRole(role) {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'toolresult') return role;
  if (role === 'tool') return 'toolresult';
  return undefined;
}

function buildRecentMessagesForMediaIntent(event) {
  const messages = extractMessageLists(event)[0] ?? [];
  return messages
    .slice(-8)
    .map((message) => {
      if (!isPlainRecord(message)) return null;
      const role = normalizePlannerRole(message.role);
      if (!role) return null;
      const text = boundedText(extractMessageText(message));
      return text ? { role, text } : { role };
    })
    .filter(Boolean);
}

function isCurrentTurnMediaSideEffectAuthorized(plan) {
  return isPlainRecord(plan)
    && plan.intentKind === 'current_media_task'
    && plan.currentTurnMediaRequest === true
    && (
      plan.action === 'image_generate'
      || plan.action === 'image_edit'
      || plan.action === 'video_generate'
      || plan.action === 'desktop_screenshot'
    );
}

function allowedMediaToolsForPlan(plan) {
  if (!isCurrentTurnMediaSideEffectAuthorized(plan)) return [];
  if (plan.action === 'image_generate' || plan.action === 'image_edit') return ['image_generate'];
  if (plan.action === 'video_generate') return ['video_generate'];
  return [];
}

function summarizeMediaIntentPlan(plan) {
  if (!isPlainRecord(plan)) return {};
  return {
    action: plan.action,
    source: plan.source,
    intentKind: plan.intentKind,
    currentTurnMediaRequest: plan.currentTurnMediaRequest,
    confidence: plan.confidence,
    reason: typeof plan.reason === 'string' ? boundedText(plan.reason, 160) : undefined,
  };
}

function rememberMediaIntentGate(event, ctx, gate) {
  const runId = getRunId(event, ctx);
  const sessionKey = getSessionKey(event, ctx);
  const record = {
    ...gate,
    runId,
    sessionKey,
    updatedAt: Date.now(),
  };
  if (runId) mediaIntentGateByRunId.set(runId, record);
  if (sessionKey) mediaIntentGateBySessionKey.set(sessionKey, record);
  pruneMediaIntentGateCache();
  return record;
}

function pruneMediaIntentGateCache(now = Date.now()) {
  for (const [runId, record] of mediaIntentGateByRunId.entries()) {
    if (!record?.updatedAt || now - record.updatedAt > MEDIA_INTENT_GATE_TTL_MS) {
      mediaIntentGateByRunId.delete(runId);
    }
  }
  for (const [sessionKey, record] of mediaIntentGateBySessionKey.entries()) {
    if (!record?.updatedAt || now - record.updatedAt > MEDIA_INTENT_GATE_TTL_MS) {
      mediaIntentGateBySessionKey.delete(sessionKey);
    }
  }
}

function resolveMediaIntentGate(event, ctx) {
  pruneMediaIntentGateCache();
  const runId = getRunId(event, ctx);
  if (runId && mediaIntentGateByRunId.has(runId)) return mediaIntentGateByRunId.get(runId);
  const sessionKey = getSessionKey(event, ctx);
  if (sessionKey && mediaIntentGateBySessionKey.has(sessionKey)) return mediaIntentGateBySessionKey.get(sessionKey);
  return undefined;
}

function normalizeHostApiOrigin() {
  const origin = normalizeOptionalString(process.env.CLAWX_HOST_API_ORIGIN);
  return origin ? origin.replace(/\/+$/, '') : undefined;
}

async function requestMediaIntentPlanFromHost(event) {
  const prompt = extractLatestUserRequestText(event).trim();
  if (!prompt) {
    return {
      ok: false,
      reason: 'missing_prompt',
      promptChars: 0,
    };
  }

  const origin = normalizeHostApiOrigin();
  const token = normalizeOptionalString(process.env.CLAWX_HOST_API_TOKEN);
  if (!origin || !token || typeof fetch !== 'function') {
    return {
      ok: false,
      reason: !origin ? 'missing_host_api_origin' : !token ? 'missing_host_api_token' : 'fetch_unavailable',
      promptChars: prompt.length,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_INTENT_GATE_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/media/intent-plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        requestedMode: 'chat',
        recentMessages: buildRecentMessagesForMediaIntent(event),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `host_api_http_${response.status}`,
        promptChars: prompt.length,
      };
    }
    const payload = await response.json();
    if (!payload || payload.success === false || !payload.plan) {
      return {
        ok: false,
        reason: 'host_api_missing_plan',
        promptChars: prompt.length,
      };
    }
    return {
      ok: true,
      plan: payload.plan,
      promptChars: prompt.length,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'host_api_timeout' : 'host_api_exception',
      promptChars: prompt.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildMediaIntentGate(event, ctx) {
  const result = await requestMediaIntentPlanFromHost(event);
  const plan = result.ok ? result.plan : undefined;
  const allowedMediaTools = allowedMediaToolsForPlan(plan);
  const gate = rememberMediaIntentGate(event, ctx, {
    source: result.ok ? 'host-planner' : 'fallback',
    reason: result.ok ? (plan?.reason || 'host_planner') : result.reason,
    promptChars: result.promptChars,
    plan: summarizeMediaIntentPlan(plan),
    allowedMediaTools,
    currentTurnMediaRequest: Boolean(plan?.currentTurnMediaRequest),
    authorized: allowedMediaTools.length > 0,
  });
  logDiagnostic('media-intent-gate', {
    eventId: eventId(event, ctx),
    promptChars: gate.promptChars,
    source: gate.source,
    action: gate.plan?.action,
    intentKind: gate.plan?.intentKind,
    currentTurnMediaRequest: gate.currentTurnMediaRequest,
    authorized: gate.authorized,
    allowedMediaTools: gate.allowedMediaTools,
    reason: gate.reason,
  });
  return gate;
}

function normalizeToolName(event) {
  return normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name)
    ?? '';
}

function normalizeToolParams(event) {
  if (isPlainRecord(event?.params)) return event.params;
  if (isPlainRecord(event?.input)) return event.input;
  if (isPlainRecord(event?.args)) return event.args;
  return {};
}

function normalizeToolAction(params) {
  const raw = normalizeOptionalString(params?.action)
    ?? normalizeOptionalString(params?.mode)
    ?? normalizeOptionalString(params?.operation);
  return raw ? raw.toLowerCase() : '';
}

function isSafeMediaToolReadAction(params) {
  const action = normalizeToolAction(params);
  return Boolean(action && SAFE_MEDIA_TOOL_ACTIONS.has(action));
}

function shouldBlockMediaToolCall(event, ctx) {
  const toolName = normalizeToolName(event);
  if (!MEDIA_SIDE_EFFECT_TOOLS.has(toolName)) {
    return { block: false, toolName };
  }
  const params = normalizeToolParams(event);
  if (isSafeMediaToolReadAction(params)) {
    return {
      block: false,
      toolName,
      reason: 'safe_media_tool_read_action',
    };
  }
  const gate = resolveMediaIntentGate(event, ctx);
  const allowed = Boolean(gate?.allowedMediaTools?.includes(toolName));
  return {
    block: !allowed,
    toolName,
    gate,
    reason: allowed ? 'authorized_current_media_task' : (gate?.reason || 'missing_media_intent_gate'),
  };
}

function buildMediaToolBlockReason(decision) {
  if (decision.toolName === 'video_generate') {
    return '当前用户消息没有授权生成视频，已阻止 video_generate 执行。';
  }
  return '当前用户消息没有授权生成图片，已阻止 image_generate 执行。';
}

function isArtifactCapabilityQuestion(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  return ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && ARTIFACT_CAPABILITY_QUESTION_RE.test(value)
    && !ARTIFACT_CREATE_COMMAND_RE.test(value);
}

function isArtifactRequest(text) {
  if (isArtifactCapabilityQuestion(text)) return false;
  return ARTIFACT_REQUEST_RE.test(text) || PAGE_ARTIFACT_RE.test(text);
}

function isArtifactRevisionFeedback(text) {
  const value = String(text ?? '');
  return ARTIFACT_REVISION_FEEDBACK_RE.test(value) && !ARTIFACT_REVISION_NEGATION_RE.test(value);
}

function isDesktopActionRequest(text) {
  return DESKTOP_ACTION_REQUEST_RE.test(text ?? '');
}

function isHeartbeatPoll(text) {
  resetRegex(HEARTBEAT_POLL_RE);
  return HEARTBEAT_POLL_RE.test(String(text ?? ''));
}

function isHeartbeatOk(text) {
  resetRegex(HEARTBEAT_OK_RE);
  return HEARTBEAT_OK_RE.test(String(text ?? ''));
}

function inferRequestedArtifactKind(text) {
  const source = String(text ?? '');
  if (/(?:PPT|pptx?|演示文稿|幻灯片|deck|slides?)/iu.test(source)) return 'presentation';
  if (/(?:Word|docx?|文档|报告|标书|投标书|招投标书|方案|稿子|文章|内容|文案|copy)/iu.test(source)) return 'document';
  if (/(?:Excel|xlsx?|表格|电子表格|工作簿|spreadsheet|workbook|csv|tsv)/iu.test(source)) return 'spreadsheet';
  if (/(?:PDF|pdf)/iu.test(source)) return 'pdf';
  if (/(?:图片|图像|海报|插画|封面|照片|image|photo|png|jpe?g|webp|svg)/iu.test(source)) return 'image';
  if (/(?:视频|video|mp4|mov|webm)/iu.test(source)) return 'video';
  if (/(?:网页|HTML|html|页面|小程序|webpage|website|site|app|应用)/iu.test(source)) return 'webpage';
  if (/(?:脚本|代码|script|code|js|ts|python|py)/iu.test(source)) return 'code';
  if (/(?:压缩包|zip|archive)/iu.test(source)) return 'archive';
  return undefined;
}

function countCompositeRequiredArtifacts(text) {
  if (!COMPOSITE_CONTRACT_RE.test(text ?? '')) return 0;
  const taskMatches = String(text ?? '').match(COMPOSITE_TASK_RE) ?? [];
  const requiredMatches = String(text ?? '').match(COMPOSITE_REQUIRED_ARTIFACT_RE) ?? [];
  return Math.max(taskMatches.length, requiredMatches.length);
}

function matchRawCompositeArtifactDetectors(text) {
  const source = String(text ?? '');
  if (!source.trim()) return [];

  const matched = [];
  for (const detector of RAW_COMPOSITE_ARTIFACT_DETECTORS) {
    resetRegex(detector.pattern);
    if (detector.pattern.test(source)) matched.push(detector);
  }

  const hasCompositeCue = RAW_COMPOSITE_STRONG_CUE_RE.test(source) || RAW_COMPOSITE_SEPARATOR_RE.test(source);
  const hasStrongCompositeCue = RAW_COMPOSITE_STRONG_CUE_RE.test(source);
  if (!hasCompositeCue) return [];
  if (!hasStrongCompositeCue && matched.length < 3) return [];
  return matched.length >= 2 ? matched : [];
}

function countRawCompositeRequiredArtifacts(text) {
  return matchRawCompositeArtifactDetectors(text).length;
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function truncateText(value, maxChars = 240) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function resetRegex(regex) {
  regex.lastIndex = 0;
  return regex;
}

function stringifyJson(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function stripArtifactRef(value) {
  return String(value ?? '')
    .trim()
    .replace(/^MEDIA:\s*/iu, '')
    .replace(/^[("'`]+/u, '')
    .replace(/[)"'`，,。；;：:\]}]+$/u, '')
    .trim();
}

function isUrlRef(value) {
  return /^https?:\/\//iu.test(value);
}

function normalizeLocalPath(value, cwd) {
  if (!value || isUrlRef(value)) return undefined;
  if (value.startsWith('~/')) return `${homedir()}${value.slice(1)}`;
  if (value.startsWith('./') || value.startsWith('../')) {
    return resolve(typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd(), value);
  }
  return value;
}

function inferArtifactKind(ref) {
  const clean = ref.toLowerCase().split('?')[0] ?? ref.toLowerCase();
  if (/\.(png|jpe?g|webp|svg)$/iu.test(clean)) return 'image';
  if (/\.(mp4|mov|webm)$/iu.test(clean)) return 'video';
  if (/\.pdf$/iu.test(clean)) return 'pdf';
  if (/\.(xlsx?|csv|tsv)$/iu.test(clean)) return 'spreadsheet';
  if (/\.pptx?$/iu.test(clean)) return 'presentation';
  if (/\.(docx?|md|txt)$/iu.test(clean)) return 'document';
  if (/\.html?$/iu.test(clean)) return 'webpage';
  if (/\.(js|ts|tsx|jsx|css|py|json)$/iu.test(clean)) return 'code';
  if (/\.zip$/iu.test(clean)) return 'archive';
  return 'file';
}

function inferMimeType(ref) {
  const clean = ref.toLowerCase().split('?')[0] ?? ref.toLowerCase();
  if (/\.png$/iu.test(clean)) return 'image/png';
  if (/\.jpe?g$/iu.test(clean)) return 'image/jpeg';
  if (/\.webp$/iu.test(clean)) return 'image/webp';
  if (/\.svg$/iu.test(clean)) return 'image/svg+xml';
  if (/\.mp4$/iu.test(clean)) return 'video/mp4';
  if (/\.webm$/iu.test(clean)) return 'video/webm';
  if (/\.pdf$/iu.test(clean)) return 'application/pdf';
  if (/\.pptx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (/\.docx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.xlsx$/iu.test(clean)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.csv$/iu.test(clean)) return 'text/csv';
  if (/\.html?$/iu.test(clean)) return 'text/html';
  if (/\.json$/iu.test(clean)) return 'application/json';
  return undefined;
}

function artifactTitle(ref) {
  try {
    const withoutQuery = ref.split('?')[0] ?? ref;
    return basename(withoutQuery) || undefined;
  } catch {
    return undefined;
  }
}

function verificationForArtifact(artifact, localPath, isUrl) {
  const base = {
    kind: 'artifact.availability',
    required: true,
    source: RUNTIME_EVENT_SOURCE,
  };
  if (isUrl) {
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'passed',
      severity: 'info',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '最终回复包含可访问 URL 形式的产物引用。',
      targetId: artifact.id,
      artifactId: artifact.id,
      evidence: artifact.url,
    };
  }

  if (!localPath) {
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'blocked',
      severity: 'blocking',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '最终回复引用了产物，但无法解析为本地文件路径。',
      targetId: artifact.id,
      artifactId: artifact.id,
    };
  }

  try {
    if (!existsSync(localPath)) {
      return {
        ...base,
        id: `verification:${artifact.id}:availability`,
        status: 'blocked',
        severity: 'blocking',
        title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
        detail: '最终回复引用了产物路径，但本地文件不可访问。',
        targetId: artifact.id,
        artifactId: artifact.id,
        evidence: localPath,
      };
    }

    const stat = statSync(localPath);
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'passed',
      severity: 'info',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: stat.isDirectory() ? '本地产物目录存在。' : '本地产物文件存在。',
      targetId: artifact.id,
      artifactId: artifact.id,
      evidence: `stat ok; sizeBytes=${stat.size}`,
    };
  } catch (error) {
    return {
      ...base,
      id: `verification:${artifact.id}:availability`,
      status: 'blocked',
      severity: 'blocking',
      title: artifact.title ? `验证 ${artifact.title}` : '验证产物',
      detail: '本地产物存在性验证失败。',
      targetId: artifact.id,
      artifactId: artifact.id,
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}

function collectRefsWithRegex(text, regex) {
  const refs = [];
  for (const match of text.matchAll(resetRegex(regex))) {
    const ref = stripArtifactRef(match[1] ?? match[0]);
    if (ref) refs.push(ref);
  }
  return refs;
}

function collectArtifactRefsFromText(text, options = {}) {
  const allowRawPaths = options.allowRawPaths !== false;
  const structuredRefs = [
    ...collectRefsWithRegex(text, MEDIA_ARTIFACT_PATH_RE),
    ...collectRefsWithRegex(text, ARTIFACT_URL_RE),
    ...collectRefsWithRegex(text, ARTIFACT_FIELD_RE),
  ];
  const rawPathText = [MEDIA_ARTIFACT_PATH_RE, ARTIFACT_URL_RE, ARTIFACT_FIELD_RE].reduce(
    (result, regex) => result.replace(resetRegex(regex), ' '),
    text,
  );
  return [
    ...structuredRefs,
    ...(allowRawPaths ? collectRefsWithRegex(rawPathText, ARTIFACT_PATH_RE) : []),
  ];
}

function removeArtifactRefsFromText(text) {
  return [MEDIA_ARTIFACT_PATH_RE, ARTIFACT_PATH_RE, ARTIFACT_URL_RE, ARTIFACT_FIELD_RE].reduce(
    (result, regex) => result.replace(resetRegex(regex), ' '),
    text,
  );
}

function extractArtifactRefs(event, finalText, options = {}) {
  const refs = [
    ...collectArtifactRefsFromText(finalText, options),
    ...extractMessageLists(event)
      .flatMap((messages) => messages)
      .flatMap((message) => collectArtifactRefsFromText(extractMessageText(message), options)),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildArtifactEvidence(event, finalText, options = {}) {
  return extractArtifactRefs(event, finalText, options).map((ref) => {
    const url = isUrlRef(ref) ? ref : undefined;
    const filePath = normalizeLocalPath(ref, event?.cwd);
    const idSource = filePath ?? url ?? ref;
    const artifact = {
      id: `artifact:${hashString(idSource)}`,
      kind: inferArtifactKind(ref),
      title: artifactTitle(ref),
      filePath,
      url,
      mimeType: inferMimeType(ref),
      source: RUNTIME_EVENT_SOURCE,
    };
    const verification = verificationForArtifact(artifact, filePath, Boolean(url));
    if (verification.status === 'passed' && filePath) {
      const sizeMatch = /sizeBytes=(\d+)/u.exec(verification.evidence ?? '');
      artifact.sizeBytes = sizeMatch ? Number(sizeMatch[1]) : undefined;
    }
    return { ref, artifact, verification };
  });
}

function extractToolResultText(result) {
  const parts = [];
  if (isRecord(result)) {
    for (const key of ['filePath', 'outputPath', 'output_path', 'path', 'out', 'url', 'mediaUrl', 'media_url']) {
      if (typeof result[key] === 'string') parts.push(`${key}: "${result[key]}"`);
    }
    for (const key of ['artifact', 'artifacts', 'output', 'outputs', 'files', 'media']) {
      const rendered = stringifyJson(result[key]);
      if (rendered) parts.push(rendered);
    }
  }
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (isRecord(part)) {
        if (typeof part.text === 'string') parts.push(part.text);
        if (typeof part.content === 'string') parts.push(part.content);
        if (typeof part.url === 'string') parts.push(part.url);
        if (typeof part.filePath === 'string') parts.push(`filePath: "${part.filePath}"`);
        if (typeof part.outputPath === 'string') parts.push(`outputPath: "${part.outputPath}"`);
      }
    }
  }
  parts.push(stringifyJson(result?.details));
  return parts.filter(Boolean).join('\n');
}

function isProducerToolName(toolName) {
  return PRODUCER_TOOL_RE.test(toolName ?? '');
}

function hasGeneratedArtifactCue(text) {
  return GENERATED_ARTIFACT_CUE_RE.test(text);
}

function buildToolArtifactEvidence(event) {
  const resultText = extractToolResultText(event?.result);
  const argsText = isProducerToolName(event?.toolName) ? stringifyJson(event?.args) : '';
  const text = [resultText, argsText].filter(Boolean).join('\n');
  if (!text.trim()) return [];
  return buildArtifactEvidence(
    { cwd: event?.cwd },
    text,
    { allowRawPaths: isProducerToolName(event?.toolName) || hasGeneratedArtifactCue(text) },
  );
}

function readToolStatus(result) {
  const details = isRecord(result?.details) ? result.details : {};
  const status = typeof details.status === 'string' ? details.status : undefined;
  if (status) return status;
  if (typeof details.ok === 'boolean') return details.ok ? 'ok' : 'error';
  if (typeof result?.terminate === 'boolean' && result.terminate) return 'terminated';
  return undefined;
}

function isToolError(event) {
  if (event?.isError === true) return true;
  const status = readToolStatus(event?.result);
  return typeof status === 'string' && TOOL_ERROR_STATUS_RE.test(status);
}

function summarizeToolFailure(event) {
  const details = isRecord(event?.result?.details) ? event.result.details : {};
  const candidate = [
    details.error,
    details.message,
    details.reason,
    readToolStatus(event?.result),
  ].find((value) => typeof value === 'string' && value.trim());
  return candidate ? truncateText(candidate, 180) : undefined;
}

function hasArtifactEvidence(event, finalText) {
  ARTIFACT_EVIDENCE_RE.lastIndex = 0;
  if (ARTIFACT_EVIDENCE_RE.test(finalText)) return true;
  return extractMessageLists(event).some((messages) => messages.some((message) => {
    ARTIFACT_EVIDENCE_RE.lastIndex = 0;
    return ARTIFACT_EVIDENCE_RE.test(extractMessageText(message));
  }));
}

function hasDesktopActionEvidence(event, finalText) {
  const evidenceText = [
    finalText,
    ...extractMessageLists(event)
      .flatMap((messages) => messages)
      .map((message) => {
        const rendered = extractMessageText(message);
        if (!message || typeof message !== 'object') return rendered;
        const extra = [];
        if (typeof message.toolName === 'string') extra.push(`toolName: "${message.toolName}"`);
        if (Array.isArray(message.tool_calls)) extra.push(stringifyJson(message.tool_calls));
        if (Array.isArray(message.content)) extra.push(stringifyJson(message.content));
        return [rendered, ...extra].filter(Boolean).join('\n');
      }),
  ].filter(Boolean).join('\n');
  return STRUCTURED_CONNECTOR_TOOL_RE.test(evidenceText) && STRUCTURED_CONNECTOR_SUCCESS_RE.test(evidenceText);
}

function artifactIdentityKeys(entry) {
  const artifact = entry?.artifact ?? entry;
  return [
    entry?.ref,
    artifact?.id,
    artifact?.filePath,
    artifact?.url,
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.toLowerCase());
}

function makeRequiredEffect(params) {
  const baseId = [
    params.type,
    params.intent,
    params.kind,
    params.index,
    params.targetArtifactId,
  ].filter((value) => value !== undefined && value !== null && String(value).trim()).join(':');

  return {
    id: `effect:${baseId || hashString(JSON.stringify(params))}`,
    type: params.type,
    intent: params.intent,
    kind: params.kind,
    title: params.title,
    minCount: params.minCount ?? 1,
    afterLatestUser: params.afterLatestUser ?? true,
    mustBeNewArtifact: params.mustBeNewArtifact ?? false,
    targetArtifactId: params.targetArtifactId,
    targetArtifactRef: params.targetArtifactRef,
    targetArtifactKeys: params.targetArtifactKeys,
    required: true,
    source: RUNTIME_EVENT_SOURCE,
  };
}

function deriveRequiredEffects({
  activeUserText,
  artifactRequest,
  artifactRevisionRequest,
  priorArtifacts,
  desktopActionRequest,
  compositeRequiredArtifactCount,
}) {
  const effects = [];
  const rawCompositeDetectors = matchRawCompositeArtifactDetectors(activeUserText);
  const compositeCount = Math.max(compositeRequiredArtifactCount, rawCompositeDetectors.length);

  if (artifactRevisionRequest) {
    const target = priorArtifacts.at(-1);
    effects.push(makeRequiredEffect({
      type: 'create_artifact_revision',
      intent: 'artifact_revision',
      kind: inferRequestedArtifactKind(activeUserText) ?? target?.artifact?.kind,
      title: '产物修订',
      minCount: 1,
      mustBeNewArtifact: true,
      targetArtifactId: target?.artifact?.id,
      targetArtifactRef: target?.ref,
      targetArtifactKeys: target ? artifactIdentityKeys(target) : undefined,
    }));
  } else if (artifactRequest) {
    if (compositeCount > 1) {
      rawCompositeDetectors.forEach((detector, index) => {
        effects.push(makeRequiredEffect({
          type: 'create_artifact',
          intent: detector.id,
          kind: detector.kind,
          title: detector.title,
          index: index + 1,
          minCount: 1,
        }));
      });
      for (let index = effects.length; index < compositeCount; index += 1) {
        effects.push(makeRequiredEffect({
          type: 'create_artifact',
          intent: 'composite_artifact',
          title: `组合产物 ${index + 1}`,
          index: index + 1,
          minCount: 1,
        }));
      }
    } else {
      effects.push(makeRequiredEffect({
        type: 'create_artifact',
        intent: 'artifact_delivery',
        kind: inferRequestedArtifactKind(activeUserText),
        title: '产物交付',
        minCount: 1,
      }));
    }
  }

  if (desktopActionRequest) {
    effects.push(makeRequiredEffect({
      type: 'external_action',
      intent: 'desktop_or_message_action',
      kind: 'desktop_or_message',
      title: '桌面或外部消息动作',
      minCount: 1,
    }));
  }

  return effects;
}

function artifactKindSatisfies(requiredKind, actualKind) {
  if (!requiredKind || requiredKind === 'file') return true;
  if (!actualKind) return false;
  if (requiredKind === actualKind) return true;
  const compatibleKinds = {
    document: ['document', 'pdf'],
    webpage: ['webpage', 'code', 'archive'],
    code: ['code', 'archive'],
  };
  return compatibleKinds[requiredKind]?.includes(actualKind) ?? false;
}

function artifactSatisfiesEffect(effect, entry, usedArtifactIds) {
  const artifact = entry?.artifact;
  if (!artifact?.id || usedArtifactIds.has(artifact.id)) return false;
  if (entry?.verification?.status !== 'passed') return false;
  if (!artifactKindSatisfies(effect.kind, artifact.kind)) return false;
  if (effect.mustBeNewArtifact) {
    const targetKeys = new Set(effect.targetArtifactKeys ?? []);
    if (artifactIdentityKeys(entry).some((key) => targetKeys.has(key))) return false;
  }
  return true;
}

function evaluateRequiredEffects(requiredEffects, evidence) {
  const usedArtifactIds = new Set();
  return requiredEffects.map((effect) => {
    if (effect.type === 'external_action') {
      return {
        effect,
        satisfied: Boolean(evidence.desktopActionEvidence),
        matchedCount: evidence.desktopActionEvidence ? 1 : 0,
        matchedArtifactIds: [],
        reason: evidence.desktopActionEvidence ? '可靠 connector 执行证据已存在。' : '缺少可靠 connector 执行证据。',
      };
    }

    const matches = [];
    for (const entry of evidence.artifacts ?? []) {
      if (!artifactSatisfiesEffect(effect, entry, usedArtifactIds)) continue;
      matches.push(entry);
      if (matches.length >= effect.minCount) break;
    }

    const satisfied = matches.length >= effect.minCount;
    if (satisfied) {
      for (const entry of matches) usedArtifactIds.add(entry.artifact.id);
    }

    return {
      effect,
      satisfied,
      matchedCount: matches.length,
      matchedArtifactIds: matches.map((entry) => entry.artifact.id),
      reason: satisfied
        ? '已找到满足 effect 的新产物证据。'
        : effect.mustBeNewArtifact
          ? '缺少 latest user 之后产生的非覆盖新产物证据。'
          : '缺少满足 effect 的产物证据或可用性验证未通过。',
    };
  });
}

function isExplicitBlocker(finalText) {
  const narrativeText = removeArtifactRefsFromText(finalText);
  return BLOCKER_RE.test(narrativeText) && !CONTINUATION_RE.test(narrativeText);
}

function analyzeArtifactFinal(event) {
  const userText = extractUserRequestText(event);
  const latestUserText = extractLatestUserRequestText(event);
  const activeUserText = latestUserText || userText;
  const finalText = extractFinalAssistantText(event);
  const heartbeatPoll = isHeartbeatPoll(activeUserText);
  const heartbeatOk = isHeartbeatOk(finalText);
  const { before: eventBeforeLatestUser, after: eventAfterLatestUser } = splitEventMessagesAroundLatestUser(event);
  const priorArtifacts = buildArtifactEvidence(eventBeforeLatestUser, '');
  const priorArtifactEvidence = priorArtifacts.length > 0 || hasArtifactEvidence(eventBeforeLatestUser, '');
  const artifactRevisionFeedback = isArtifactRevisionFeedback(activeUserText);
  const artifactRevisionRequest = artifactRevisionFeedback && priorArtifactEvidence;
  const compositeRequiredArtifactCount = countCompositeRequiredArtifacts(activeUserText);
  const rawCompositeRequiredArtifactCount = countRawCompositeRequiredArtifacts(activeUserText);
  const inferredRequiredArtifactCount = Math.max(compositeRequiredArtifactCount, rawCompositeRequiredArtifactCount);
  const artifactRequest = isArtifactRequest(activeUserText) || inferredRequiredArtifactCount > 0 || artifactRevisionRequest;
  const desktopActionRequest = isDesktopActionRequest(activeUserText);
  const artifacts = buildArtifactEvidence(eventAfterLatestUser, finalText);
  const finalArtifacts = buildArtifactEvidence({ cwd: event?.cwd }, finalText);
  const artifactEvidence = artifacts.length > 0 || hasArtifactEvidence(eventAfterLatestUser, finalText);
  const finalArtifactEvidence = finalArtifacts.length > 0 || hasArtifactEvidence({ cwd: event?.cwd }, finalText);
  const desktopActionEvidence = hasDesktopActionEvidence(event, finalText);
  const requiredEffects = deriveRequiredEffects({
    activeUserText,
    artifactRequest,
    artifactRevisionRequest,
    priorArtifacts,
    desktopActionRequest,
    compositeRequiredArtifactCount,
  });
  const effectResults = evaluateRequiredEffects(requiredEffects, {
    artifacts,
    desktopActionEvidence,
  });
  const missingRequiredEffects = effectResults.filter((result) => !result.satisfied);
  const satisfiedRequiredEffects = effectResults.filter((result) => result.satisfied);
  const missingArtifactEffects = missingRequiredEffects.filter((result) => (
    result.effect.type === 'create_artifact' || result.effect.type === 'create_artifact_revision'
  ));
  const missingDesktopActionEffects = missingRequiredEffects.filter((result) => result.effect.type === 'external_action');
  const verificationPassed = artifacts.some(({ verification }) => verification.status === 'passed');
  const verificationBlocked = artifacts.some(({ verification }) => verification.status === 'blocked' || verification.status === 'failed');
  const finalVerificationPassed = finalArtifacts.some(({ verification }) => verification.status === 'passed');
  const finalVerificationBlocked = finalArtifacts.some(({ verification }) => verification.status === 'blocked' || verification.status === 'failed');
  const passedArtifactCount = artifacts.filter(({ verification }) => verification.status === 'passed').length;
  const requiredArtifactCount = requiredEffects
    .filter((effect) => effect.type === 'create_artifact' || effect.type === 'create_artifact_revision')
    .reduce((total, effect) => total + (effect.minCount ?? 1), 0);
  const missingRequiredArtifactCount = missingArtifactEffects.length;
  const explicitBlocker = isExplicitBlocker(finalText);
  const promiseOnly = PROMISE_ONLY_RE.test(finalText);
  const artifactRepairPromise = artifactRequest && promiseOnly && ARTIFACT_REPAIR_PROMISE_CUE_RE.test(finalText);
  const unfinishedArtifactPromise = Boolean(
    artifactRequest
    && promiseOnly
    && (!finalVerificationPassed || artifactRepairPromise),
  );
  const unresolvedFinalVerificationBlock = Boolean(
    artifactRequest
    && finalVerificationBlocked
    && !finalVerificationPassed,
  );
  const shouldReviseArtifact = Boolean(
    userText.trim()
    && artifactRequest
    && !explicitBlocker
    && (
      missingArtifactEffects.length > 0
      || unfinishedArtifactPromise
      || unresolvedFinalVerificationBlock
    ),
  );
  const shouldReviseDesktopAction = Boolean(
    userText.trim()
    && finalText.trim()
    && desktopActionRequest
    && !explicitBlocker
    && missingDesktopActionEffects.length > 0,
  );
  const shouldReviseHeartbeat = Boolean(
    heartbeatPoll
    && finalText.trim()
    && !heartbeatOk,
  );
  const shouldRevise = shouldReviseHeartbeat || shouldReviseArtifact || shouldReviseDesktopAction;
  return {
    userText,
    latestUserText,
    activeUserText,
    finalText,
    heartbeatPoll,
    heartbeatOk,
    artifactRequest,
    artifactRevisionFeedback,
    artifactRevisionRequest,
    priorArtifactEvidence,
    priorArtifactCount: priorArtifacts.length,
    desktopActionRequest,
    compositeRequiredArtifactCount,
    rawCompositeRequiredArtifactCount,
    requiredEffects,
    effectResults,
    satisfiedRequiredEffects,
    missingRequiredEffects,
    requiredArtifactCount,
    passedArtifactCount,
    missingRequiredArtifactCount,
    artifacts,
    finalArtifacts,
    artifactEvidence,
    finalArtifactEvidence,
    desktopActionEvidence,
    verificationPassed,
    verificationBlocked,
    finalVerificationPassed,
    finalVerificationBlocked,
    explicitBlocker,
    promiseOnly,
    artifactRepairPromise,
    unfinishedArtifactPromise,
    unresolvedFinalVerificationBlock,
    shouldReviseHeartbeat,
    shouldReviseArtifact,
    shouldReviseDesktopAction,
    shouldRevise,
  };
}

function shouldReviseArtifactFinal(event) {
  return analyzeArtifactFinal(event).shouldRevise;
}

function buildRevision(analysis) {
  if (analysis?.shouldReviseHeartbeat) {
    return {
      action: 'revise',
      reason: 'UClaw heartbeat poll produced user-visible non-heartbeat content.',
      retry: {
        idempotencyKey: `${REVISION_ID}:heartbeat`,
        maxAttempts: 1,
        instruction: [
          '最新用户消息是内部心跳 `[OpenClaw heartbeat poll]`，不是用户的新任务。',
          '不要继续历史任务、不要评价上一轮、不要承诺补做，也不要输出任何产物说明。',
          '本轮最终回复必须只包含：HEARTBEAT_OK',
        ].join('\n'),
      },
    };
  }
  if (analysis?.shouldReviseDesktopAction && !analysis?.shouldReviseArtifact) {
    return {
      action: 'revise',
      reason: 'UClaw desktop or external message action final reply had no reliable execution evidence.',
      retry: {
        idempotencyKey: `${REVISION_ID}:desktop-action`,
        maxAttempts: 1,
        instruction: [
          '用户要求的是本机应用/外部消息动作，不能用“我会打开/我已发送”这类没有证据的回复结束。',
          '先检查当前工具清单是否有可靠结构化 connector（例如 message、directory 或 channel 工具）并能解析目标；如果有，继续用该 connector 执行并验证。',
          '不要建议启用 uclaw-computer-use，也不要使用 shell/盲键鼠/UI 脚本假装完成微信或桌面操作。',
          '如果没有可靠 connector，最终回复必须明确说明当前运行时缺少可靠桌面/消息发送能力；可以给出待发送消息草稿，但必须标明未发送。',
        ].join('\n'),
      },
    };
  }
  if (analysis?.artifactRevisionRequest) {
    return {
      action: 'revise',
      reason: 'UClaw artifact revision final reply had no new completed artifact evidence.',
      retry: {
        idempotencyKey: `${REVISION_ID}:artifact-revision`,
        maxAttempts: 2,
        instruction: [
          '用户是在评价或否定上一轮已生成产物，这等价于要求重做/改进产物。',
          '不要只说“我会重做/我直接重做/我来优化”；现在必须继续执行，定位上一轮 MEDIA 路径或最近产物，创建一个新的非覆盖改进版。',
          '优先使用可用的 create_* 文件工具或相关 skill；如果没有专用工具，就用 exec 结合 Node/Python/uv 读取旧产物信息并重新生成。',
          '生成后必须用可用工具验证新文件存在，并在最终回复中返回新的 MEDIA:<absolute-path> 或新的绝对文件路径。',
          '如果确实无法继续，最终回复必须说明已经尝试的路径、具体缺失能力或阻塞点。',
        ].join('\n'),
      },
    };
  }
  return {
    action: 'revise',
    reason: REVISION_REASON,
    retry: {
      idempotencyKey: REVISION_ID,
      maxAttempts: 2,
      instruction: [
        '用户要的是真实本地产物，不要用“我会生成/我将处理/接下来我会”这类未来承诺结束。',
        '现在继续执行：优先使用可用的 create_* 文件工具或相关 skill；如果没有专用工具，就用 exec 结合 Node/Python/uv 临时构造执行路径。',
        '生成后必须用可用工具验证文件存在，并在最终回复中返回 MEDIA:<absolute-path> 或绝对文件路径。',
        '如果确实无法继续，最终回复必须说明已经尝试的路径、具体缺失能力或阻塞点。',
      ].join('\n'),
    },
  };
}

function getRunId(event, ctx) {
  return normalizeOptionalString(event?.runId) ?? normalizeOptionalString(ctx?.runId);
}

function getSessionKey(event, ctx) {
  return normalizeOptionalString(event?.sessionKey) ?? normalizeOptionalString(ctx?.sessionKey);
}

function resolveAgentEventEmitter(api) {
  if (typeof api?.agent?.events?.emitAgentEvent === 'function') {
    return api.agent.events.emitAgentEvent.bind(api.agent.events);
  }
  if (typeof api?.emitAgentEvent === 'function') {
    return api.emitAgentEvent.bind(api);
  }
  return undefined;
}

function emitRuntimeEvent(api, event, stream, data) {
  const runId = getRunId(event);
  const emit = resolveAgentEventEmitter(api);
  if (!runId || !emit) return { emitted: false, reason: !runId ? 'missing-run-id' : 'missing-emitter' };
  try {
    return emit({
      runId,
      stream,
      data,
      contractVersion: 1,
      producer: RUNTIME_EVENT_SOURCE,
      seq: ++runtimeEventSeq,
      ts: Date.now(),
      ...(getSessionKey(event) ? { sessionKey: getSessionKey(event) } : {}),
    });
  } catch (error) {
    logDiagnostic('runtime-event-error', {
      eventId: eventId(event),
      stream,
      error: error instanceof Error ? error.message : String(error),
    });
    return { emitted: false, reason: 'emit-failed' };
  }
}

function buildGateIssue(event, params) {
  const runId = getRunId(event) ?? eventId(event);
  const target = params.targetId ?? params.artifactId ?? params.verificationId ?? params.stepId ?? runId;
  return {
    id: `gate:${runId}:${params.code}:${hashString(`${target}:${params.title}`)}`,
    code: params.code,
    severity: params.severity ?? 'blocking',
    title: params.title,
    detail: params.detail,
    targetId: params.targetId,
    artifactId: params.artifactId,
    verificationId: params.verificationId,
    stepId: params.stepId,
    recoverable: params.recoverable,
    suggestedRecovery: params.suggestedRecovery,
  };
}

function emitGateIssue(api, event, issue) {
  emitRuntimeEvent(api, event, 'issue', {
    issue,
    source: RUNTIME_EVENT_SOURCE,
  });
}

function emitCompletionCheckpoint(api, event, analysis, reason) {
  if (!analysis.artifactRequest && !analysis.desktopActionRequest) return;
  if (analysis.desktopActionRequest && (!analysis.artifactRequest || analysis.shouldReviseDesktopAction || analysis.explicitBlocker)) {
    const issue = buildGateIssue(event, {
      code: analysis.explicitBlocker ? 'desktop.action.blocked' : 'desktop.action.evidence.missing',
      title: analysis.explicitBlocker
        ? '桌面或外部消息动作存在阻塞'
        : '桌面或外部消息动作缺少可靠执行证据',
      detail: reason,
      targetId: getRunId(event) ?? eventId(event),
      recoverable: !analysis.explicitBlocker,
      suggestedRecovery: analysis.explicitBlocker
        ? '需要接入可靠结构化 connector 或由用户手动执行；当前不能声称已经完成桌面/外部消息动作。'
        : '继续使用可用的 message/directory/channel connector 执行并验证；如果没有 connector，改为明确报告未发送和缺失能力。',
    });
    emitGateIssue(api, event, issue);
    emitRuntimeEvent(api, event, 'checkpoint', {
      checkpointId: `checkpoint:${getRunId(event) ?? eventId(event)}:desktop-action-gate`,
      summary: analysis.explicitBlocker
        ? '桌面或外部消息动作被明确阻塞。'
        : '完成门禁要求补齐桌面或外部消息动作的可靠执行证据。',
      reason,
      recoverable: !analysis.explicitBlocker,
      issues: [issue],
      suggestedRecovery: issue.suggestedRecovery,
      source: RUNTIME_EVENT_SOURCE,
    });
    return;
  }
  const issue = buildGateIssue(event, {
    code: analysis.explicitBlocker ? 'artifact.delivery.blocked' : 'artifact.required.missing',
    title: analysis.explicitBlocker
      ? '最终回复声明产物交付存在阻塞'
      : '任务需要产物，但最终回复缺少真实产物证据',
    detail: reason,
    targetId: getRunId(event) ?? eventId(event),
    recoverable: true,
    suggestedRecovery: '继续执行实际产物生成步骤，并在最终回复中提供 MEDIA:<absolute-path> 或已验证路径。',
  });
  emitGateIssue(api, event, issue);
  emitRuntimeEvent(api, event, 'checkpoint', {
    checkpointId: `checkpoint:${getRunId(event) ?? eventId(event)}:artifact-gate`,
    summary: analysis.explicitBlocker
      ? '最终回复声明产物交付存在阻塞。'
      : '完成门禁要求继续执行产物交付任务。',
    reason,
    recoverable: true,
    issues: [issue],
    suggestedRecovery: issue.suggestedRecovery,
    source: RUNTIME_EVENT_SOURCE,
  });
}

function emitRuntimeContractEvents(api, event, analysis) {
  for (const { artifact, verification } of analysis.artifacts) {
    emitRuntimeEvent(api, event, 'artifact', {
      artifact,
      source: RUNTIME_EVENT_SOURCE,
    });
    emitRuntimeEvent(api, event, 'verification', {
      verification,
      source: RUNTIME_EVENT_SOURCE,
    });
  }

  if (analysis.explicitBlocker) {
    emitCompletionCheckpoint(api, event, analysis, truncateText(analysis.finalText));
    return;
  }

  if (analysis.shouldRevise) {
    const artifactGateReason = analysis.missingRequiredArtifactCount > 0 && analysis.passedArtifactCount > 0
      ? `最终回复只满足 ${analysis.passedArtifactCount}/${analysis.requiredArtifactCount} 个产物 effect，仍缺少 ${analysis.missingRequiredArtifactCount} 个。`
      : analysis.artifactEvidence
        ? '最终回复引用了产物，但完成门禁没有得到通过：缺少满足当前 effect 的产物验证证据。'
        : '最终回复缺少真实产物证据。';
    emitCompletionCheckpoint(
      api,
      event,
      analysis,
      analysis.shouldReviseDesktopAction && !analysis.shouldReviseArtifact
        ? '最终回复缺少可靠桌面或外部消息动作执行证据。'
        : artifactGateReason,
    );
  }
}

function buildMiddlewareRunEvent(event, ctx) {
  return {
    runId: ctx?.runId,
    sessionKey: ctx?.sessionKey,
    cwd: event?.cwd,
  };
}

function buildToolStep(event) {
  const failed = isToolError(event);
  const status = failed ? 'error' : 'completed';
  const statusDetail = readToolStatus(event?.result);
  return {
    id: event?.toolCallId ? `tool:${event.toolCallId}` : `tool:${hashString(event?.toolName ?? 'unknown')}`,
    title: event?.toolName ? `工具 ${event.toolName}` : '工具执行',
    status,
    kind: 'tool',
    detail: statusDetail ? `status=${statusDetail}` : undefined,
  };
}

function emitToolResultRuntimeEvents(api, event, ctx) {
  const runEvent = buildMiddlewareRunEvent(event, ctx);
  if (!getRunId(runEvent)) return;

  emitRuntimeEvent(api, runEvent, 'step', {
    step: buildToolStep(event),
    toolCallId: event?.toolCallId,
    source: RUNTIME_EVENT_SOURCE,
  });

  const failed = isToolError(event);
  if (failed) {
    const issue = buildGateIssue(runEvent, {
      code: 'tool.failed',
      title: event?.toolName ? `工具 ${event.toolName} 执行失败` : '工具执行失败',
      detail: summarizeToolFailure(event),
      targetId: event?.toolCallId ?? hashString(event?.toolName ?? 'tool'),
      stepId: event?.toolCallId,
      recoverable: true,
      suggestedRecovery: '修复工具错误或换用可用执行路径后重试该步骤。',
    });
    emitGateIssue(api, runEvent, issue);
    emitRuntimeEvent(api, runEvent, 'checkpoint', {
      checkpointId: `checkpoint:${getRunId(runEvent)}:${event?.toolCallId ?? hashString(event?.toolName ?? 'tool')}:tool-error`,
      summary: event?.toolName ? `工具 ${event.toolName} 执行失败。` : '工具执行失败。',
      reason: summarizeToolFailure(event),
      recoverable: true,
      issues: [issue],
      suggestedRecovery: issue.suggestedRecovery,
      source: RUNTIME_EVENT_SOURCE,
    });
    return;
  }

  const artifacts = buildToolArtifactEvidence(event);
  for (const { artifact, verification } of artifacts) {
    const artifactWithSource = {
      ...artifact,
      sourceToolCallId: event?.toolCallId,
    };
    const verificationWithSource = {
      ...verification,
      targetId: artifactWithSource.id,
      artifactId: artifactWithSource.id,
    };

    emitRuntimeEvent(api, runEvent, 'artifact', {
      artifact: artifactWithSource,
      toolCallId: event?.toolCallId,
      source: RUNTIME_EVENT_SOURCE,
    });
    emitRuntimeEvent(api, runEvent, 'verification', {
      verification: verificationWithSource,
      toolCallId: event?.toolCallId,
      source: RUNTIME_EVENT_SOURCE,
    });

    if (verificationWithSource.status === 'blocked' || verificationWithSource.status === 'failed') {
      const issue = buildGateIssue(runEvent, {
        code: 'verification.required.failed',
        title: `${artifactWithSource.title ?? artifactWithSource.filePath ?? artifactWithSource.id} 未通过产物验证`,
        detail: verificationWithSource.detail ?? verificationWithSource.evidence,
        targetId: artifactWithSource.id,
        artifactId: artifactWithSource.id,
        verificationId: verificationWithSource.id,
        recoverable: true,
        suggestedRecovery: '重新生成该产物，或确认路径/URL 可访问后再交付。',
      });
      emitGateIssue(api, runEvent, issue);
      emitRuntimeEvent(api, runEvent, 'checkpoint', {
        checkpointId: `checkpoint:${getRunId(runEvent)}:${event?.toolCallId ?? artifactWithSource.id}:artifact-verification`,
        summary: '工具返回产物引用，但可用性验证未通过。',
        reason: verificationWithSource.detail ?? verificationWithSource.evidence,
        recoverable: true,
        issues: [issue],
        suggestedRecovery: issue.suggestedRecovery,
        source: RUNTIME_EVENT_SOURCE,
      });
    }
  }
}

function registerToolResultMiddleware(api) {
  if (typeof api.registerAgentToolResultMiddleware !== 'function') return;
  api.registerAgentToolResultMiddleware((event, ctx) => {
    emitToolResultRuntimeEvents(api, event, ctx);
  }, {
    runtimes: ['openclaw'],
  });
}

function registerLifecycleHook(api, name, handler, options) {
  if (typeof api.on === 'function') {
    api.on(name, handler, options);
    return true;
  }
  if (typeof api.registerHook === 'function') {
    api.registerHook(name, handler, options);
    return true;
  }
  return false;
}

function registerArtifactGuard(api) {
  registerToolResultMiddleware(api);
  if (typeof api.registerHook === 'function' || typeof api.on === 'function') {
    registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
      await buildMediaIntentGate(event, ctx);
      logDiagnostic('prompt-context', {
        eventId: eventId(event, ctx),
        injected: true,
        contextChars: PROMPT_CONTEXT.length,
        hasChineseRule: true,
        hasArtifactRule: true,
      });
      return {
        appendSystemContext: PROMPT_CONTEXT,
      };
    }, {
      name: PROMPT_CONTEXT_HOOK_ID,
      description: 'Ensure UClaw artifact delivery, media-intent gating, and Chinese language rules are present before workspace context is ready.',
      timeoutMs: MEDIA_INTENT_GATE_TIMEOUT_MS + 2_000,
    });
    registerLifecycleHook(api, 'before_tool_call', (event, ctx) => {
      const decision = shouldBlockMediaToolCall(event, ctx);
      if (!decision.toolName || !MEDIA_SIDE_EFFECT_TOOLS.has(decision.toolName)) return;
      logDiagnostic('media-tool-gate', {
        eventId: eventId(event, ctx),
        toolName: decision.toolName,
        blocked: decision.block,
        reason: decision.reason,
        gateSource: decision.gate?.source,
        gateAction: decision.gate?.plan?.action,
        gateIntentKind: decision.gate?.plan?.intentKind,
        gateAuthorized: decision.gate?.authorized,
      });
      if (!decision.block) return;
      const blockReason = buildMediaToolBlockReason(decision);
      return {
        block: true,
        blockReason,
        reason: blockReason,
      };
    }, {
      name: MEDIA_INTENT_TOOL_GATE_HOOK_ID,
      description: 'Block image/video generation tools unless the current turn has structured media intent authorization.',
      priority: 100,
    });
    registerLifecycleHook(api, 'before_agent_finalize', (event, ctx) => {
      const analysis = analyzeArtifactFinal(event);
      logDiagnostic('finalize-check', {
        eventId: eventId(event, ctx),
        userTextChars: analysis.userText.length,
        finalTextChars: analysis.finalText.length,
        heartbeatPoll: analysis.heartbeatPoll,
        heartbeatOk: analysis.heartbeatOk,
        artifactRequest: analysis.artifactRequest,
        artifactRevisionFeedback: analysis.artifactRevisionFeedback,
        artifactRevisionRequest: analysis.artifactRevisionRequest,
        priorArtifactEvidence: analysis.priorArtifactEvidence,
        priorArtifactCount: analysis.priorArtifactCount,
        compositeRequiredArtifactCount: analysis.compositeRequiredArtifactCount,
        rawCompositeRequiredArtifactCount: analysis.rawCompositeRequiredArtifactCount,
        requiredEffectCount: analysis.requiredEffects.length,
        missingRequiredEffectCount: analysis.missingRequiredEffects.length,
        requiredEffectTypes: analysis.requiredEffects.map((effect) => effect.type),
        requiredArtifactCount: analysis.requiredArtifactCount,
        passedArtifactCount: analysis.passedArtifactCount,
        missingRequiredArtifactCount: analysis.missingRequiredArtifactCount,
        artifactEvidence: analysis.artifactEvidence,
        finalArtifactEvidence: analysis.finalArtifactEvidence,
        artifactCount: analysis.artifacts.length,
        finalArtifactCount: analysis.finalArtifacts.length,
        verificationPassed: analysis.verificationPassed,
        verificationBlocked: analysis.verificationBlocked,
        finalVerificationPassed: analysis.finalVerificationPassed,
        finalVerificationBlocked: analysis.finalVerificationBlocked,
        explicitBlocker: analysis.explicitBlocker,
        promiseOnly: analysis.promiseOnly,
        artifactRepairPromise: analysis.artifactRepairPromise,
        unfinishedArtifactPromise: analysis.unfinishedArtifactPromise,
        unresolvedFinalVerificationBlock: analysis.unresolvedFinalVerificationBlock,
        desktopActionRequest: analysis.desktopActionRequest,
        desktopActionEvidence: analysis.desktopActionEvidence,
        shouldReviseHeartbeat: analysis.shouldReviseHeartbeat,
        shouldRevise: analysis.shouldRevise,
      });
      emitRuntimeContractEvents(api, event, analysis);
      if (!analysis.shouldRevise) return;
      return buildRevision(analysis);
    }, {
      name: REVISION_ID,
      description: 'Avoid ending artifact delivery tasks with unexecuted future-tense promises.',
    });
  }
}

export default {
  id: PLUGIN_ID,
  name: 'UClaw Artifact Guard',
  version: '0.1.2',
  register(api) {
    registerArtifactGuard(api);
  },
};

export const __test = {
  shouldReviseArtifactFinal,
  analyzeArtifactFinal,
  isArtifactCapabilityQuestion,
  isArtifactRequest,
  deriveRequiredEffects,
  evaluateRequiredEffects,
  buildRevision,
  buildArtifactEvidence,
  buildToolArtifactEvidence,
  emitToolResultRuntimeEvents,
  emitRuntimeEvent,
  PROMPT_CONTEXT,
};
