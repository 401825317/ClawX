const PLUGIN_ID = 'uclaw-artifact-guard';
const REVISION_ID = `${PLUGIN_ID}:artifact-delivery`;
const REVISION_REASON = 'UClaw artifact delivery final reply had no completed artifact evidence.';
const PROMPT_CONTEXT_HOOK_ID = `${PLUGIN_ID}:artifact-delivery-context`;
const PROMPT_CONTEXT = [
  'UClaw 交付与语言规则：',
  '- 默认所有面向用户的自然语言回复必须使用简体中文；不要因为工具、技能、日志、模板或上一次回复是英文而切换成英文。',
  '- 用户要求生成、创建、导出、美化或打开 PPT/PPTX、Word/DOCX、Excel/XLSX、PDF、文档、报告、表格、图片、网页、脚本或压缩包时，必须交付真实本地产物，不能只回复计划、承诺、大纲或说明。',
  '- 如果专用产物工具不可用，继续使用可用的 skill、exec、Node、Python 或 uv 路径创建文件；只有完成并验证、遇到具体阻塞点、或需要用户确认时才能结束。',
  '- 文件任务最终回复必须包含 MEDIA:<absolute-path> 或已验证的绝对文件路径。',
].join('\n');

const ARTIFACT_REQUEST_RE = /(?:(?:做|制作|生成|创建|输出|导出|整理成|写|编写|起草|出|弄|做个|做一份|生成一份|创建一份).{0,40}(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|网页|HTML|html|脚本|代码文件|压缩包|zip)|(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|网页|HTML|html|脚本|代码文件|压缩包|zip).{0,40}(?:做|制作|生成|创建|输出|导出|整理|编写|起草|成稿|成品)|(?:create|make|generate|build|produce|export|write).{0,50}(?:file|document|report|proposal|bid|tender|presentation|slides?|pptx?|docx?|xlsx?|spreadsheet|pdf|image|html|script|zip))/iu;
const PAGE_ARTIFACT_RE = /(?:做|生成|写|编写|起草).{0,20}\d+\s*(?:页|page|pages).{0,20}(?:文档|报告|标书|投标书|招投标书|方案|Word|docx?|PDF|pdf)?/iu;
const PROMISE_ONLY_RE = /(?:^(?:好(?:的)?[，,。\\s]*)?(?:我(?:会|将|来|准备|可以|马上|先|接下来|现在会)|(?:接下来|下一步|随后|稍后).{0,12}(?:我)?(?:会|将)|I(?:'ll| will| can| am going to)|Next(?:,| I)|I can).{0,160}(?:生成|创建|制作|编写|起草|输出|整理|排版|导出|处理|完成|make|create|generate|write|produce|export))/iu;
const CONTINUATION_RE = /(?:我(?:会|将|准备|打算|可以|马上|先|来)|接下来|下一步|随后|稍后|now I|I(?:'ll| will| can| am going to)|next)/iu;
const ARTIFACT_EVIDENCE_RE = /(?:MEDIA:\s*(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>]+|(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)[^\s`"'<>]+\.(?:pptx?|docx?|xlsx?|pdf|csv|tsv|md|html?|json|zip|png|jpe?g|webp|svg|txt|py|js|ts|tsx|jsx|css)\b|filePath["']?\s*:\s*["'][^"']+|(?:^|[\s"'`])out["']?\s*:\s*["'][^"']+)/iu;
const BLOCKER_RE = /(?:无法|不能|失败|报错|缺少|没有可用|找不到|不存在|权限|需要(?:你|用户).{0,24}(?:确认|提供|授权)|请(?:你|用户).{0,24}(?:确认|提供|授权)|blocked|cannot|can't|failed|missing|permission|not found|need you to)/iu;

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

function eventId(event) {
  return [
    event?.runId,
    event?.sessionId,
    event?.sessionKey,
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

function isArtifactRequest(text) {
  return ARTIFACT_REQUEST_RE.test(text) || PAGE_ARTIFACT_RE.test(text);
}

function hasArtifactEvidence(event, finalText) {
  if (ARTIFACT_EVIDENCE_RE.test(finalText)) return true;
  return extractMessageLists(event).some((messages) => messages.some((message) => (
    ARTIFACT_EVIDENCE_RE.test(extractMessageText(message))
  )));
}

function isExplicitBlocker(finalText) {
  return BLOCKER_RE.test(finalText) && !CONTINUATION_RE.test(finalText);
}

function analyzeArtifactFinal(event) {
  const userText = extractUserRequestText(event);
  const finalText = extractFinalAssistantText(event);
  const artifactRequest = isArtifactRequest(userText);
  const artifactEvidence = hasArtifactEvidence(event, finalText);
  const explicitBlocker = isExplicitBlocker(finalText);
  const promiseOnly = PROMISE_ONLY_RE.test(finalText);
  const shouldRevise = Boolean(
    userText.trim()
    && finalText.trim()
    && artifactRequest
    && !artifactEvidence
    && !explicitBlocker
    && promiseOnly,
  );
  return {
    userText,
    finalText,
    artifactRequest,
    artifactEvidence,
    explicitBlocker,
    promiseOnly,
    shouldRevise,
  };
}

function shouldReviseArtifactFinal(event) {
  return analyzeArtifactFinal(event).shouldRevise;
}

function buildRevision() {
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

function registerArtifactGuard(api) {
  if (typeof api.registerHook !== 'function') return;
  api.registerHook('before_prompt_build', (event) => {
    logDiagnostic('prompt-context', {
      eventId: eventId(event),
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
    description: 'Ensure UClaw artifact delivery and Chinese language rules are present even before workspace context is ready.',
  });
  api.registerHook('before_agent_finalize', (event) => {
    const analysis = analyzeArtifactFinal(event);
    logDiagnostic('finalize-check', {
      eventId: eventId(event),
      userTextChars: analysis.userText.length,
      finalTextChars: analysis.finalText.length,
      artifactRequest: analysis.artifactRequest,
      artifactEvidence: analysis.artifactEvidence,
      explicitBlocker: analysis.explicitBlocker,
      promiseOnly: analysis.promiseOnly,
      shouldRevise: analysis.shouldRevise,
    });
    if (!analysis.shouldRevise) return;
    return buildRevision();
  }, {
    name: REVISION_ID,
    description: 'Avoid ending artifact delivery tasks with unexecuted future-tense promises.',
  });
}

export default {
  id: PLUGIN_ID,
  name: 'UClaw Artifact Guard',
  version: '0.1.0',
  register(api) {
    registerArtifactGuard(api);
  },
};

export const __test = {
  shouldReviseArtifactFinal,
  analyzeArtifactFinal,
  buildRevision,
  PROMPT_CONTEXT,
};
