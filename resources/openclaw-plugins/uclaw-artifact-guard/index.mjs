import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, realpath as realpathAsync, stat as statAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const PLUGIN_ID = 'uclaw-artifact-guard';
const REVISION_ID = `${PLUGIN_ID}:artifact-delivery`;
const REVISION_REASON = 'UClaw artifact delivery final reply had no completed artifact evidence.';
const PROMPT_CONTEXT_HOOK_ID = `${PLUGIN_ID}:artifact-delivery-context`;
const MEDIA_TOOL_PREPARATION_HOOK_ID = `${PLUGIN_ID}:media-tool-preparation`;
const RUNTIME_EVENT_SOURCE = PLUGIN_ID;
const TURN_CONTRACT_TOOL_NAME = 'uclaw_declare_turn_contract';
let runtimeEventSeq = 0;
const BASE_PROMPT_CONTEXT = [
  'UClaw 基础回复规则：',
  '- 默认所有面向用户的自然语言回复必须使用简体中文；不要因为工具、技能、日志、模板或上一次回复是英文而切换成英文。',
  '- 先判断当前用户真实意图；普通工程诊断、配置查询和只读分析任务应优先查证事实、引用证据路径，不要套用产物生成流程。',
].join('\n');
const ARTIFACT_PROMPT_CONTEXT = [
  'UClaw 产物与外部操作规则（仅在当前轮涉及产物、媒体或本地应用操作时适用）：',
  '- 用户要求生成、创建、导出、美化或打开 PPT/PPTX、Word/DOCX、Excel/XLSX、PDF、文档、报告、表格、图片、网页、脚本或压缩包时，必须交付真实本地产物，不能只回复计划、承诺、大纲或说明。',
  '- 用户对上一轮已生成的产物给出负反馈或修改意图（例如太丑、不满意、不行、重做、换一版、美化、优化）时，应视为新的产物修订任务：必须直接制作一个新的非覆盖改进版，不能只评价或承诺。',
  '- 如果专用产物工具不可用，继续使用可用的 skill、exec、Node、Python 或 uv 路径创建文件；只有完成并验证、遇到具体阻塞点、或需要用户确认时才能结束。',
  '- 用户明确要求文章、小说、故事、剧本等长文本及目标字数/词数时，目标长度属于完成条件；必须读取最终文本核验，不足时继续补写和复核，不能把提纲、序章或片段当成完整交付。',
  '- 文件任务最终回复必须包含 MEDIA:<absolute-path> 或已验证的绝对文件路径。',
  '- 旧的 uclaw-computer-use 插件不属于可靠执行面；不要把启用它当作恢复路径，也不要假装存在 computer_* 桌面工具。',
  '- 如果确实需要用 shell 生成临时截图或图片供后续视觉/图片工具读取，必须写入 OpenClaw media/workspace 目录，例如 `~/.openclaw/media/outbound/`；不要写入裸 `/tmp/*.png`，因为本地媒体读取会拒绝非受管目录。',
  '- 用户要求打开/操作微信、QQ、钉钉、飞书、本机浏览器或其他本地应用并发送外部消息时，只有在当前工具清单存在可靠结构化 connector 且已经得到工具成功证据后，才能说“已发送/已打开”。',
  '- 如果没有可靠 connector，必须用简体中文说明具体能力缺失或阻塞点，可以给出消息草稿，但不能声称已经操作桌面或发出消息。',
].join('\n');
const PROMPT_CONTEXT = `${BASE_PROMPT_CONTEXT}\n\n${ARTIFACT_PROMPT_CONTEXT}`;

const TURN_PREFERENCES_TIMEOUT_MS = 1_200;
const MEDIA_SIDE_EFFECT_TOOLS = new Set(['image_generate', 'video_generate', 'create_blender_scene', 'repair_blender_scene']);
const NATIVE_MEDIA_GENERATION_TOOLS = new Set(['image_generate', 'video_generate']);
const NATIVE_MEDIA_PROMPT_MAX_CHARACTERS = 4_096;
const HIDDEN_PROGRESS_TOOLS = new Set([
  'tool_describe',
  'tool_search',
  'uclaw_declare_turn_contract',
  'uclaw_get_runtime_capabilities',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
]);
const ASYNC_PROGRESS_STARTED_STATUSES = new Set([
  'accepted',
  'pending',
  'queued',
  'running',
  'started',
  'submitted',
]);
const SIDE_EFFECT_FREE_HOST_TASK_CAPABILITIES = new Set(['desktop.observe']);
const SAFE_MEDIA_TOOL_ACTIONS = new Set(['list', 'status', 'get', 'inspect', 'describe', 'models', 'model', 'info', 'help']);
const MEDIA_INPUT_PARAM_KEYS = new Set(['image', 'images', 'mask', 'video', 'videos']);
const IMAGE_INPUT_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/iu;
const VIDEO_INPUT_EXT_RE = /\.(?:mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu;
const RUN_TOOL_EVIDENCE_TTL_MS = 30 * 60 * 1000;
const RUN_TOOL_EVIDENCE_MAX_ENTRIES = 256;
const toolEvidenceByRunId = new Map();
const PROGRESS_WRAPPER_TTL_MS = 30 * 60 * 1000;
const PROGRESS_WRAPPER_MAX_ENTRIES = 512;
const progressWrappersByParentToolCallId = new Map();

const ARTIFACT_REQUEST_RE = /(?:(?:做|制作|生成|创建|输出|导出|整理成|写|编写|起草|出|弄|做个|做一份|生成一份|创建一份).{0,40}(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|脚本|代码文件|压缩包|zip)|(?:文件|文档|报告|标书|投标书|招投标书|投标文件|招标响应文件|方案|维保方案|服务方案|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|脚本|代码文件|压缩包|zip).{0,40}(?:做|制作|生成|创建|输出|导出|整理|编写|起草|成稿|成品)|(?:create|make|generate|build|produce|export|write).{0,50}(?:file|document|report|proposal|bid|tender|presentation|slides?|pptx?|docx?|xlsx?|spreadsheet|pdf|image|video|html|script|zip))/iu;
const PAGE_ARTIFACT_RE = /(?:做|生成|写|编写|起草).{0,20}\d+\s*(?:页|page|pages).{0,20}(?:文档|报告|标书|投标书|招投标书|方案|Word|docx?|PDF|pdf)?/iu;
const ARTIFACT_CAPABILITY_TARGET_RE = /(?:文件(?:类)?产物|文件|文档|报告|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|小程序|代码文件|压缩包|zip|产物|artifact|file|document|report|presentation|slides?|spreadsheet|image|video|webpage|mini[-\s]?app)/iu;
const ARTIFACT_CAPABILITY_QUESTION_RE = /(?:能做哪些|可以做哪些|支持哪些|支持生成哪些|能生成哪些|能创建哪些|能产出哪些|可以生成哪些|可以创建哪些|能(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|可以(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|支持(?:什么|哪些|哪类|哪种)|有哪些(?:能力|功能|文件|产物|类型|格式)|有什么(?:能力|功能)|能力(?:范围|列表|介绍)|(?:能|可以)做吗|能不能做|支不支持|what can you|which .{0,40} can|can you|support(?:ed)?|capabilit)/iu;
const ARTIFACT_CREATE_COMMAND_RE = /(?:(?:帮我|给我|替我|直接).{0,20}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出)|(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|(?:create|make|generate|build|produce|export|write)\s+(?:a|an|one|some|the)\b)/iu;
const ARTIFACT_CREATION_NEGATION_RE = /(?:不要|别|不用|无需|不需要|禁止|不得|do\s+not|don't|without)\s*.{0,18}?(?:写(?:入)?|做(?:成)?|改(?:动|写)?|修改|创建|生成|制作|保存|输出|导出)(?:任何)?(?:文件|文档|报告|PPT|Excel|图片|视频|网页|代码)?/giu;
const ARTIFACT_READ_ONLY_OR_KNOWLEDGE_RE = /(?:只读|查看|检查|读取|搜索|查找|分析|诊断|解释|说明|告诉我|怎么|如何|为什么|inspect|read|review|analy[sz]e|diagnose|explain|how|why).{0,50}(?:文件|文档|报告|PPT|Word|Excel|表格|PDF|图片|视频|网页|HTML|脚本|代码|package\.json|\.tsx?\b|\.jsx?\b)|(?:文件|文档|报告|PPT|Word|Excel|表格|PDF|图片|视频|网页|HTML|脚本|代码|package\.json|\.tsx?\b|\.jsx?\b).{0,50}(?:只读|查看|检查|读取|分析|诊断|解释|说明|怎么|如何|为什么|inspect|read|review|analy[sz]e|diagnose|explain|how|why)/iu;
const ARTIFACT_DIRECT_EXECUTION_RE = /(?:(?:帮我|给我|替我|直接|现在|马上|立即|立刻).{0,30}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出)|(?:然后|接着|随后|再).{0,12}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|^\s*(?:请)?\s*(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|(?:please\s+)?(?:create|make|generate|build|produce|export|write)\s+(?:a|an|one|some|the)\b)/iu;
const ARTIFACT_REVISION_FEEDBACK_RE = /(?:太丑|丑|难看|不好看|不满意|不行|不对|太差|太简陋|占位|模板感|不够.{0,12}(?:高级|好看|精致|正式|苹果|产品|宣传)|重新(?:做|制作|生成|来|搞)|重做|再做|再来|换一版|改一版|美化|优化|润色|升级|高级一点|好看一点|精致一点|重新直接制作|make it better|too ugly|ugly|not good|redo|remake|regenerate|make another|improve|polish)/iu;
const ARTIFACT_REVISION_NEGATION_RE = /(?:不要|别|不用|先别|无需|不需要|do not|don't|no need).{0,12}(?:重做|重新|修改|改|美化|优化|生成|制作|redo|remake|regenerate|improve|polish)/iu;
const LONG_FORM_CONTENT_TARGET_RE = /(?:小说|故事|长文|文章|剧本|稿件|正文|章节|novel|story|article|screenplay|manuscript|long[-\s]?form)/iu;
const LONG_FORM_CONTENT_REQUEST_RE = /(?:(?:写|创作|生成|制作|续写|扩写|补写|完成|输出|起草).{0,48}(?:小说|故事|长文|文章|剧本|稿件|正文|章节)|(?:小说|故事|长文|文章|剧本|稿件|正文|章节).{0,48}(?:写|创作|生成|制作|续写|扩写|补写|完成|输出|起草)|(?:write|create|generate|continue|expand|complete|draft).{0,48}(?:novel|story|article|screenplay|manuscript|long[-\s]?form))/iu;
const LONG_FORM_KNOWLEDGE_QUESTION_RE = /(?:(?:如何|怎么|怎样|为什么|为何|技巧|教程|方法|建议|分析|评价|点评).{0,32}(?:写|创作|续写|小说|故事|长文|文章|剧本)|(?:how|why|tips?|tutorial|guide|advice|review).{0,48}(?:write|novel|story|article|screenplay))/iu;
const TEXT_LENGTH_ARABIC_RE = /(?:至少|不少于|不低于|最少|超过|大于|约|大约|左右|不超过|至多|最多|控制在)?\s*(\d[\d,_]*(?:\.\d+)?)\s*(万|千|[kw])?\s*(字|字符|汉字|词|单词|characters?|words?)(?:\s*(?:左右|上下))?/iu;
const TEXT_LENGTH_CHINESE_RE = /(?:至少|不少于|不低于|最少|超过|大于|约|大约|左右|不超过|至多|最多|控制在)?\s*([零〇一二两三四五六七八九十百千万]+)\s*(字|字符|汉字|词|单词)(?:\s*(?:左右|上下))?/u;
const TEXT_LENGTH_MINIMUM_RE = /(?:至少|不少于|不低于|最少|超过|大于)/u;
const TEXT_LENGTH_MAXIMUM_RE = /(?:不超过|至多|最多|控制在)/u;
const TEXT_LENGTH_APPROXIMATE_RE = /(?:约|大约|左右)/u;
const TEXT_CONTENT_EXT_RE = /\.(?:md|markdown|txt|html?|json|js|mjs|cjs|ts|tsx|jsx|css|py|xml|ya?ml)$/iu;
const MAX_TEXT_CONTENT_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_POLL_RE = /^\s*\[OpenClaw heartbeat poll\]\s*$/iu;
const HEARTBEAT_OK_RE = /^\s*HEARTBEAT_OK\s*$/iu;
const INTERNAL_SENTINEL_RE = /^\s*(?:HEARTBEAT_OK|NO_REPLY)\s*$/iu;
const GATEWAY_RESTART_CONTINUATION_RE = /\[System\]\s+Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool\/model work\. Continue from the existing transcript and finish the interrupted response\./iu;
const DESIGNED_PRESENTATION_CONTRACT_RE = /\s*(?:【UClaw designed presentation execution contract v1\.】|\[UClaw designed presentation execution contract v1\.\])[\s\S]*$/iu;
const GATEWAY_RESTART_CONTINUATION_BLOCK_RE = /\n{0,2}\[System\]\s+Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool\/model work\. Continue from the existing transcript and finish the interrupted response\.(?:\n\nNote:\s+The interrupted final reply was captured:\s+"[^"]*")?/giu;
const GATEWAY_RESTART_CAPTURED_REPLY_NOTE_RE = /^\s*Note:\s+The interrupted final reply was captured:\s+"[^"]*"\s*$/giu;
const QUEUED_USER_MESSAGE_MARKER_RE = /^\s*\[Queued user message that arrived while the previous turn was still active\]\s*\n?/iu;
const RUNTIME_EVENT_CONTINUATION_RE = /^Continue the OpenClaw runtime event\.?\s*$/iu;
const PROMISE_ONLY_RE = /(?:(?:^|[。！？!?；;\n\r]\s*)(?:好(?:的)?[，,。\\s]*)?(?:我(?:会|将|来|准备|可以|马上|先|接下来|现在|继续|直接|随后|稍后)|(?:接下来|下一步|随后|稍后|现在|马上|继续).{0,12}(?:我)?(?:会|将|来|准备|可以|马上|先|继续|直接)?|I(?:'ll| will| can| am going to)|Next(?:,| I)|I can).{0,180}(?:重做|重新(?:做|制作|生成|校验|验证|测试|检查)|生成|创建|制作|编写|起草|输出|整理|排版|导出|处理|完成|修(?:复|掉|正|改)?|修改|调整|补(?:做|齐|上)|校验|验证|测试|检查|make|create|generate|write|produce|export|redo|remake|regenerate|improve|polish|fix|repair|validate|verify|test|continue))/iu;
const ARTIFACT_REPAIR_PROMISE_CUE_RE = /(?:发现.{0,80}(?:问题|不对|不符合|未通过|失败|bug|错误)|实际.{0,40}(?:生成|只有|多了|少了|不符合)|(?:多了|少了|额外).{0,30}(?:页|项|个|张|条)|首屏可见|验证未通过|校验未通过|测试未通过|不符合(?:交互|预期|要求)|空页|页数不(?:对|符)|公式(?:缺失|错误)|交互(?:异常|错误)|bug|错误)/iu;
const UNFINISHED_ARTIFACT_ADMISSION_RE = /(?:不能算(?:完成|交付)|尚未(?:完成|交付|达到|满足)|还(?:没|没有)(?:完成|交付|达到|满足)|未(?:完成|交付|达到|满足|通过)|不是(?:完整|最终|完成).{0,16}(?:成片|版本|产物|交付)|没有(?:达到|满足).{0,24}(?:要求|目标|条件)|只(?:有|完成|生成).{0,16}(?:秒|页|张|个|部分)|仍(?:需|需要)|需要(?:继续|重新|补齐|修复|修改|重做)|not (?:complete|finished|delivered)|still need(?:s)?|does not (?:meet|satisfy))/iu;
const ARTIFACT_CONTINUATION_NEGATION_RE = /(?:(?:不要|别|无需|不需要|先别).{0,24}(?:执行|继续|修改|重做|重新|生成|制作|剪辑|合成)|只(?:解释|说明|分析|给方案|说方案|讨论)|do not.{0,24}(?:execute|continue|modify|regenerate|create)|explain only)/iu;
const CONTINUATION_RE = /(?:我(?:会|将|准备|打算|可以|马上|先|来)|接下来|下一步|随后|稍后|now I|I(?:'ll| will| can| am going to)|next)/iu;
const ARTIFACT_EXT = 'pptx?|docx?|xlsx?|pdf|csv|tsv|md|html?|json|zip|png|jpe?g|webp|svg|txt|py|js|ts|tsx|jsx|css|mp4|mov|webm|blend|glb|gltf|obj|fbx';
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
const SIDE_EFFECTING_PRODUCER_TOOL_RE = /(?:^|[_-])(?:create|write|edit|repair|generate|export|render|save|capture|record)(?:$|[_-])/iu;
const REMOTE_GENERATION_TOOL_RE = /(?:^|[_-])(?:image|video|music|audio|speech|voice|sound|avatar)(?:[_-])(?:generate|generation|synthesize|synthesis)(?:$|[_-])|(?:^|[_-])(?:generate|generation|synthesize|synthesis)(?:[_-])(?:image|video|music|audio|speech|voice|sound|avatar)(?:$|[_-])/iu;
const EXTERNAL_ACTION_TOOL_RE = /(?:^|[_-])(?:send|publish|upload|delete|remove)(?:$|[_-])/iu;
const SIDE_EFFECT_FREE_TOOL_ACTIONS = new Set([
  ...SAFE_MEDIA_TOOL_ACTIONS,
  'read',
  'search',
]);
const SIDE_EFFECT_FREE_TOOL_NAME_RE = /^(?:get|list|read|search|status|inspect|describe|models?|info|help)(?:$|[_-])|(?:^|[_-])(?:status|info|details?|list)$/iu;
const TERMINAL_SIDE_EFFECT_ACTION_RE = /(?:^|[_-])(?:send|publish|upload|delete|remove|create|write|edit|repair|generate|export|render|save|capture|record)$/iu;
const GENERATED_ARTIFACT_CUE_RE = /(?:MEDIA:|filePath|outputPath|artifact|saved|wrote|created|generated|exported|rendered|已生成|已保存|已导出|已创建|写入|产物)/iu;
const TOOL_ERROR_STATUS_RE = /^(?:error|failed|failure|blocked)$/iu;
const COMPOSITE_CONTRACT_RE = /【UClaw composite execution contract】|这是一个组合任务|子任务清单：/iu;
const COMPOSITE_TASK_RE = /^\s*\d+\.\s+\[[^\]]+\]\s+.+$/gmu;
const COMPOSITE_REQUIRED_ARTIFACT_RE = /产物要求：必须为这个子任务生成一个可见、可追踪的产物/gu;
const RAW_COMPOSITE_STRONG_CUE_RE = /(?:每(?:个|项|件|类|种)(?:事儿|事情|任务|产物)?|每个事儿|各(?:来|做|生成|出)|分别|都(?:随便)?(?:给我)?(?:来|做|生成|出)|一套|组合任务|多个|多种|全都|全部)/iu;
const RAW_COMPOSITE_SEPARATOR_RE = /[，、,；;]|(?:\s+(?:和|以及|还有|并且)\s*)/u;
const SCREENSHOT_COMMAND_RE = /(?:screencapture|gnome-screenshot|scrot|grim|spectacle|import\s+-window\s+root|xwd|desktop[_-]?screenshot|screen\s*capture|screenshot|截图|截屏)/iu;
const TMP_SCREENSHOT_MEDIA_PATH_RE = /\/tmp\/((?:uclaw|clawx|desktop|screen|screenshot)[A-Za-z0-9._ -]*\.(?:png|jpe?g|webp|bmp))/giu;
const TRANSCRIPT_BLOAT_TOOL_RE = /^(?:exec|exec_command|shell|bash|terminal|run_command|read)$/iu;
const TRANSCRIPT_PATH_BOUNDARY = String.raw`(?=$|[?#\s"'},\]])`;
const TRANSCRIPT_BLOAT_SESSION_RE = new RegExp(
  String.raw`(?:^|[\\/])sessions?(?:[\\/]|$)|\.jsonl${TRANSCRIPT_PATH_BOUNDARY}|(?:^|[\\/])transcripts?(?:[\\/]|$)`,
  'iu',
);
const TRANSCRIPT_BLOAT_TRAJECTORY_RE = new RegExp(
  String.raw`(?:^|[\\/])trajectory(?:[\\/]|$)|\.trajectory(?:-path)?(?:\.jsonl|\.json)?${TRANSCRIPT_PATH_BOUNDARY}|\btrajectory(?:-path)?\b`,
  'iu',
);
const TRANSCRIPT_BLOAT_LOG_RE = new RegExp(
  String.raw`(?:^|[\\/])logs?(?:[\\/]|$)|\.log${TRANSCRIPT_PATH_BOUNDARY}`,
  'iu',
);
const TRANSCRIPT_BLOAT_MIN_CHARS = 1600;
const TRANSCRIPT_BLOAT_MIN_LINES = 36;
const TRANSCRIPT_BLOAT_EXTREME_CHARS = 5000;
const TRANSCRIPT_BLOAT_EXTREME_LINES = 120;
const TRANSCRIPT_BLOAT_MAX_HINTS = 3;
const TRANSCRIPT_BLOAT_MAX_ARTIFACT_REFS = 4;
const TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS = 8_000;
const TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS = 4_000;
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

function extractAssistantVisibleText(message) {
  if (!message || typeof message !== 'object') return '';
  const parts = [];
  const content = message.content;
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') parts.push(part.text);
        else if (typeof part.content === 'string') parts.push(part.content);
      }
    }
  }
  for (const key of ['text', 'output', 'result']) {
    if (typeof message[key] === 'string') parts.push(message[key]);
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
        // The newest assistant item is authoritative even when it is empty.
        // Falling back to an earlier tool-call-only assistant makes an empty
        // provider final look deliverable and bypasses the recovery revision.
        return extractAssistantVisibleText(message);
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

function normalizeHostApiOrigin() {
  const origin = normalizeOptionalString(process.env.CLAWX_HOST_API_ORIGIN);
  return origin ? origin.replace(/\/+$/, '') : undefined;
}

async function requestTurnPreferencesFromHost(event, ctx) {
  const sessionKey = getSessionKey(event, ctx);
  const message = extractLatestUserRequestText(event).trim();
  const origin = normalizeHostApiOrigin();
  const token = normalizeOptionalString(process.env.CLAWX_HOST_API_TOKEN);
  if (!sessionKey || !message || !origin || !token || typeof fetch !== 'function') return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_PREFERENCES_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/runtime/turn-preferences/consume`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionKey, message }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    return isPlainRecord(payload?.preferences) ? payload.preferences : undefined;
  } catch (error) {
    logDiagnostic('turn-preferences-unavailable', {
      eventId: eventId(event, ctx),
      reason: error?.name === 'AbortError' ? 'host_api_timeout' : 'host_api_exception',
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function turnPreferencePromptContext(preferences) {
  if (!isPlainRecord(preferences)) return '';
  const mode = normalizeOptionalString(preferences.mode);
  const image = isPlainRecord(preferences.image) ? preferences.image : undefined;
  const video = isPlainRecord(preferences.video) ? preferences.video : undefined;
  const selectedArtifacts = Array.isArray(preferences.selectedArtifacts)
    ? preferences.selectedArtifacts.filter(isPlainRecord).slice(0, 8)
    : [];
  const lines = [
    'UClaw 本轮 UI 偏好（不是用户消息，也不替代你的工具选择）：',
  ];
  if (mode) lines.push(`- 当前模式偏好：${mode}`);
  if (image) {
    const details = [
      normalizeOptionalString(image.model) ? `model=${normalizeOptionalString(image.model)}` : '',
      normalizeOptionalString(image.size) ? `size=${normalizeOptionalString(image.size)}` : '',
      normalizeOptionalString(image.quality) ? `quality=${normalizeOptionalString(image.quality)}` : '',
    ].filter(Boolean);
    if (details.length > 0) lines.push(`- 图片默认参数：${details.join(', ')}`);
  }
  if (video) {
    const details = [
      normalizeOptionalString(video.model) ? `model=${normalizeOptionalString(video.model)}` : '',
      normalizeOptionalString(video.size) ? `size=${normalizeOptionalString(video.size)}` : '',
      Number.isFinite(video.durationSeconds) ? `durationSeconds=${Math.floor(video.durationSeconds)}` : '',
    ].filter(Boolean);
    if (details.length > 0) lines.push(`- 视频默认参数：${details.join(', ')}`);
  }
  if (selectedArtifacts.length > 0) {
    lines.push('- 用户已选中的候选产物：');
    for (const artifact of selectedArtifacts) {
      const filePath = normalizeOptionalString(artifact.filePath);
      const title = normalizeOptionalString(artifact.title);
      if (filePath) lines.push(`  - ${title || 'artifact'}: ${filePath}`);
    }
  }
  lines.push('- 只有在完整会话上下文确实需要媒体能力时才调用原生工具；不要因模式偏好自动生成。');
  return lines.join('\n');
}

function shouldInjectArtifactPromptContext(event, preferences) {
  // OpenClaw owns semantic intent and tool selection. Keep the execution
  // contract available on every real turn instead of deciding whether the
  // user "sounds like" an artifact request with client-side text matching.
  return Boolean(extractLatestUserRequestText(event).trim() || preferences);
}

function buildPromptContextForEvent(event, preferences) {
  const includeArtifactContext = shouldInjectArtifactPromptContext(event, preferences);
  const preferenceContext = turnPreferencePromptContext(preferences);
  return {
    text: [includeArtifactContext
      ? `${BASE_PROMPT_CONTEXT}\n\n${ARTIFACT_PROMPT_CONTEXT}`
      : BASE_PROMPT_CONTEXT, preferenceContext].filter(Boolean).join('\n\n'),
    includeArtifactContext,
  };
}

function normalizeToolName(event) {
  const direct = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name)
    ?? '';
  let resolved = direct;
  if (direct.trim().toLowerCase() === 'tool_call') {
    const params = normalizeToolParams(event);
    resolved = [params.id, params.toolName, params.tool_name, params.name]
      .find((value) => typeof value === 'string' && value.trim())?.trim()
      ?? direct;
    if (resolved === direct) {
      const envelope = parseProgressRecord(event?.result);
      const delegated = isPlainRecord(envelope?.result) ? envelope.result : envelope;
      const tool = isPlainRecord(envelope?.tool)
        ? envelope.tool
        : isPlainRecord(delegated?.tool)
          ? delegated.tool
          : undefined;
      resolved = [tool?.name, tool?.id, tool?.toolName, tool?.tool_name]
        .find((value) => typeof value === 'string' && value.trim())?.trim()
        ?? resolved;
    }
  }
  return resolved.includes(':') ? resolved.split(':').at(-1) ?? resolved : resolved;
}

function normalizeDirectToolName(event) {
  const direct = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name)
    ?? '';
  const normalized = direct.includes(':') ? direct.split(':').at(-1) ?? direct : direct;
  return normalized.trim().toLowerCase();
}

function normalizeToolParams(event) {
  if (isPlainRecord(event?.params)) return event.params;
  if (isPlainRecord(event?.input)) return event.input;
  if (isPlainRecord(event?.args)) return event.args;
  return {};
}

function normalizeEffectiveToolParams(event) {
  const params = normalizeToolParams(event);
  const directName = normalizeOptionalString(event?.toolName)
    ?? normalizeOptionalString(event?.name)
    ?? normalizeOptionalString(event?.tool?.name);
  if (directName?.trim().toLowerCase() !== 'tool_call') return params;
  return [params.args, params.arguments, params.params, params.input]
    .map((value) => isPlainRecord(value) ? value : null)
    .find(Boolean)
    ?? params;
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

function resolveOpenClawHomeForPlugin() {
  const explicitHome = normalizeOptionalString(process.env.OPENCLAW_HOME);
  if (!explicitHome) return homedir();
  if (explicitHome === '~' || explicitHome.startsWith('~/') || explicitHome.startsWith('~\\')) {
    return resolve(explicitHome.replace(/^~(?=$|[\\/])/, homedir()));
  }
  return resolve(explicitHome);
}

function expandOpenClawPathForPlugin(value) {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(value.replace(/^~(?=$|[\\/])/, resolveOpenClawHomeForPlugin()));
  }
  return value;
}

function resolveOpenClawConfigDirForPlugin() {
  const explicitStateDir = normalizeOptionalString(process.env.OPENCLAW_STATE_DIR);
  if (explicitStateDir) return resolve(expandOpenClawPathForPlugin(explicitStateDir));
  const explicitConfigPath = normalizeOptionalString(process.env.OPENCLAW_CONFIG_PATH)
    ?? normalizeOptionalString(process.env.OPENCLAW_CONFIG);
  if (explicitConfigPath) return dirname(resolve(expandOpenClawPathForPlugin(explicitConfigPath)));
  return join(resolveOpenClawHomeForPlugin(), '.openclaw');
}

function resolveManagedScreenshotDir() {
  return join(resolveOpenClawConfigDirForPlugin(), 'media', 'outbound');
}

function isRemoteOrManagedMediaRef(value) {
  return /^(?:https?:|data:|blob:|media:)/iu.test(String(value ?? '').trim());
}

function mediaInputExtensionAllowed(paramKey, filePath) {
  if (paramKey === 'video' || paramKey === 'videos') return VIDEO_INPUT_EXT_RE.test(filePath);
  return IMAGE_INPUT_EXT_RE.test(filePath);
}

function resolveLocalMediaInputPath(value) {
  const input = normalizeOptionalString(value);
  if (!input || isRemoteOrManagedMediaRef(input)) return undefined;
  const expanded = expandOpenClawPathForPlugin(input);
  if (!isAbsolute(expanded) && !expanded.startsWith('./') && !expanded.startsWith('../')) return undefined;
  return resolve(expanded);
}

async function stageMediaInputFile({ sourceValue, paramKey, runDir }) {
  const resolvedSource = resolveLocalMediaInputPath(sourceValue);
  if (!resolvedSource || !mediaInputExtensionAllowed(paramKey, resolvedSource)) return undefined;

  let sourcePath;
  let sourceStat;
  try {
    sourcePath = await realpathAsync(resolvedSource);
    sourceStat = await statAsync(sourcePath);
  } catch {
    return undefined;
  }
  if (!sourceStat.isFile()) return undefined;
  const relativeToRunDir = relative(runDir, sourcePath);
  if (!relativeToRunDir || (!relativeToRunDir.startsWith('..') && !isAbsolute(relativeToRunDir))) {
    return sourcePath;
  }

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const extension = extname(sourcePath).toLowerCase();
  const fingerprint = hashString(`${sourcePath}:${sourceStat.size}:${sourceStat.mtimeMs}`);
  const stagedPath = join(runDir, `${fingerprint}${extension}`);
  let stagedStat;
  try {
    stagedStat = await statAsync(stagedPath);
  } catch {
    stagedStat = undefined;
  }
  if (!stagedStat?.isFile() || stagedStat.size !== sourceStat.size) {
    await copyFile(sourcePath, stagedPath);
    stagedStat = await statAsync(stagedPath);
  }
  if (!stagedStat.isFile() || stagedStat.size !== sourceStat.size) {
    throw new Error('staged media verification failed');
  }
  return stagedPath;
}

async function stageMediaToolInputs(event, ctx) {
  const toolName = normalizeToolName(event);
  const params = normalizeToolParams(event);
  if (!MEDIA_SIDE_EFFECT_TOOLS.has(toolName) || isSafeMediaToolReadAction(params)) {
    return { params, stagedCount: 0, stagedParamKeys: [] };
  }

  const runId = getRunId(event, ctx);
  if (!runId) return { params, stagedCount: 0, stagedParamKeys: [] };
  const runDir = join(resolveManagedScreenshotDir(), 'uclaw-runs', hashString(runId));
  const nextParams = { ...params };
  const stagedBySource = new Map();
  const stagedParamKeys = new Set();
  let stagedCount = 0;

  try {
    for (const paramKey of MEDIA_INPUT_PARAM_KEYS) {
      const rawValue = params[paramKey];
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      let changed = false;
      const nextValues = [];
      for (const value of values) {
        if (typeof value !== 'string') {
          nextValues.push(value);
          continue;
        }
        let stagedPath = stagedBySource.get(`${paramKey}:${value}`);
        if (!stagedPath) {
          stagedPath = await stageMediaInputFile({ sourceValue: value, paramKey, runDir });
          if (stagedPath) stagedBySource.set(`${paramKey}:${value}`, stagedPath);
        }
        if (stagedPath) {
          nextValues.push(stagedPath);
          changed = changed || stagedPath !== value;
          stagedCount += stagedPath !== value ? 1 : 0;
        } else {
          nextValues.push(value);
        }
      }
      if (!changed) continue;
      nextParams[paramKey] = Array.isArray(rawValue) ? nextValues : nextValues[0];
      stagedParamKeys.add(paramKey);
    }
  } catch (error) {
    return {
      params,
      stagedCount: 0,
      stagedParamKeys: [],
      blockReason: '参考媒体无法安全复制到当前运行的受控目录，已阻止本次媒体生成。',
      errorCode: normalizeOptionalString(error?.code) ?? 'stage_failed',
    };
  }

  return {
    params: nextParams,
    stagedCount,
    stagedParamKeys: [...stagedParamKeys],
  };
}

function commandParamKey(params) {
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof params?.[key] === 'string' && params[key].trim()) return key;
  }
  return undefined;
}

function rewriteTmpScreenshotMediaPaths(command) {
  const original = String(command ?? '');
  if (!SCREENSHOT_COMMAND_RE.test(original)) return null;

  const managedScreenshotDir = resolveManagedScreenshotDir();
  const rewrittenPaths = [];
  const rewritten = original.replace(TMP_SCREENSHOT_MEDIA_PATH_RE, (match, fileName) => {
    const replacement = join(managedScreenshotDir, fileName);
    if (replacement !== match) {
      rewrittenPaths.push({ from: match, to: replacement });
    }
    return replacement;
  });
  if (rewrittenPaths.length === 0 || rewritten === original) return null;

  return {
    command: `mkdir -p ${managedScreenshotDir} && ${rewritten}`,
    rewrittenPaths,
  };
}

function rewriteExecScreenshotParams(event) {
  const toolName = normalizeToolName(event);
  if (!/^(?:exec|exec_command|shell|bash|terminal|run_command)$/iu.test(toolName)) return null;
  const params = normalizeToolParams(event);
  const key = commandParamKey(params);
  if (!key) return null;
  const rewrite = rewriteTmpScreenshotMediaPaths(params[key]);
  if (!rewrite) return null;
  return {
    params: {
      ...params,
      [key]: rewrite.command,
    },
    rewrittenPaths: rewrite.rewrittenPaths,
    commandKey: key,
    toolName,
  };
}

function isArtifactCapabilityQuestion(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  return ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && ARTIFACT_CAPABILITY_QUESTION_RE.test(value)
    && !ARTIFACT_CREATE_COMMAND_RE.test(value);
}

function parseChineseInteger(value) {
  const digits = {
    '零': 0,
    '〇': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
  };
  const units = { '十': 10, '百': 100, '千': 1_000 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const character of String(value ?? '')) {
    if (Object.prototype.hasOwnProperty.call(digits, character)) {
      number = digits[character];
      continue;
    }
    if (character === '万') {
      section += number;
      total += Math.max(1, section) * 10_000;
      section = 0;
      number = 0;
      continue;
    }
    const unit = units[character];
    if (!unit) return undefined;
    section += Math.max(1, number) * unit;
    number = 0;
  }
  const parsed = total + section + number;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeTextLengthUnit(value) {
  return /(?:词|单词|words?)/iu.test(String(value ?? '')) ? 'words' : 'characters';
}

function requestedTextLength(text) {
  const source = String(text ?? '');
  const arabicMatch = TEXT_LENGTH_ARABIC_RE.exec(source);
  const chineseMatch = arabicMatch ? null : TEXT_LENGTH_CHINESE_RE.exec(source);
  if (!arabicMatch && !chineseMatch) return undefined;

  const matchedText = (arabicMatch?.[0] ?? chineseMatch?.[0] ?? '').trim();
  const suffix = arabicMatch?.[2]?.toLowerCase();
  const base = arabicMatch
    ? Number(String(arabicMatch[1]).replace(/[,_]/gu, ''))
    : parseChineseInteger(chineseMatch?.[1]);
  const multiplier = suffix === '万' || suffix === 'w'
    ? 10_000
    : suffix === '千' || suffix === 'k'
      ? 1_000
      : 1;
  const target = Math.round(Number(base) * multiplier);
  if (!Number.isFinite(target) || target <= 0) return undefined;

  const unit = normalizeTextLengthUnit(arabicMatch?.[3] ?? chineseMatch?.[2]);
  const maximumOnly = TEXT_LENGTH_MAXIMUM_RE.test(matchedText);
  const minimumExplicit = TEXT_LENGTH_MINIMUM_RE.test(matchedText);
  const approximate = TEXT_LENGTH_APPROXIMATE_RE.test(matchedText);
  return {
    unit,
    target,
    min: maximumOnly ? undefined : minimumExplicit ? target : Math.max(1, Math.floor(target * 0.9)),
    max: maximumOnly ? target : approximate ? Math.ceil(target * 1.1) : undefined,
    qualifier: maximumOnly ? 'maximum' : minimumExplicit ? 'minimum' : approximate ? 'approximate' : 'target',
    source: matchedText,
  };
}

function isArtifactRequest(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const actionableText = value.replace(ARTIFACT_CREATION_NEGATION_RE, ' ');
  if (isArtifactCapabilityQuestion(actionableText)) return false;
  if (
    ARTIFACT_READ_ONLY_OR_KNOWLEDGE_RE.test(actionableText)
    && !ARTIFACT_DIRECT_EXECUTION_RE.test(actionableText)
  ) {
    return false;
  }
  const longFormRequest = LONG_FORM_CONTENT_TARGET_RE.test(actionableText)
    && LONG_FORM_CONTENT_REQUEST_RE.test(actionableText)
    && !LONG_FORM_KNOWLEDGE_QUESTION_RE.test(actionableText);
  return ARTIFACT_REQUEST_RE.test(actionableText) || PAGE_ARTIFACT_RE.test(actionableText) || longFormRequest;
}

function isUndeclaredArtifactDeliveryRequest(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const actionableText = value.replace(ARTIFACT_CREATION_NEGATION_RE, ' ');
  return isArtifactRequest(value)
    && (ARTIFACT_DIRECT_EXECUTION_RE.test(actionableText) || ARTIFACT_CREATE_COMMAND_RE.test(actionableText));
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

function isOpenClawRuntimeEventPromptText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  resetRegex(RUNTIME_EVENT_CONTINUATION_RE);
  if (RUNTIME_EVENT_CONTINUATION_RE.test(normalized)) return true;
  return normalized.split(/\n+/u).some((line) => {
    resetRegex(RUNTIME_EVENT_CONTINUATION_RE);
    return RUNTIME_EVENT_CONTINUATION_RE.test(line.trim());
  });
}

function isRuntimeSystemInjectionText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  if (/^\s*System\s*\(untrusted\)\s*:/iu.test(normalized)) return true;
  if (
    /An async command you ran earlier has completed/iu.test(normalized)
    && /Do not relay it to the user unless explicitly requested/iu.test(normalized)
  ) {
    return true;
  }
  if (/^\[Inter-session message\]/iu.test(normalized)) return true;
  if (isOpenClawRuntimeEventPromptText(normalized)) return true;
  if (
    /^\s*Current time\s*:/iu.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/iu.test(normalized)
  ) {
    return true;
  }
  return false;
}

function isInternalTranscriptText(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return false;
  resetRegex(INTERNAL_SENTINEL_RE);
  return INTERNAL_SENTINEL_RE.test(normalized)
    || isHeartbeatPoll(normalized)
    || GATEWAY_RESTART_CONTINUATION_RE.test(normalized)
    || isRuntimeSystemInjectionText(normalized);
}

function classifyInternalTranscriptMessage(message) {
  if (!isPlainRecord(message)) return undefined;
  const role = String(message.role ?? '').toLowerCase();
  const text = extractMessageText(message);
  const normalized = text.trim();
  if (!normalized) return undefined;

  resetRegex(INTERNAL_SENTINEL_RE);
  if (INTERNAL_SENTINEL_RE.test(normalized)) return 'internal_sentinel';
  if (role === 'user' && isHeartbeatPoll(normalized)) return 'heartbeat_poll_user';
  if ((role === 'toolresult' || role === 'tool_result' || role === 'tool') && isHeartbeatPoll(normalized)) {
    return 'heartbeat_poll_tool_result';
  }
  if ((role === 'user' || role === 'system') && GATEWAY_RESTART_CONTINUATION_RE.test(normalized)) {
    return 'gateway_restart_continuation';
  }
  if ((role === 'user' || role === 'assistant' || role === 'system') && isRuntimeSystemInjectionText(normalized)) {
    return 'runtime_system_injection';
  }
  return undefined;
}

function isInternalTranscriptMessage(message) {
  return Boolean(classifyInternalTranscriptMessage(message));
}

function stripGatewayRestartContinuationText(value) {
  const original = String(value ?? '');
  const cleaned = original
    .replace(GATEWAY_RESTART_CONTINUATION_BLOCK_RE, '')
    .replace(GATEWAY_RESTART_CAPTURED_REPLY_NOTE_RE, '')
    .replace(QUEUED_USER_MESSAGE_MARKER_RE, '')
    .trim();
  return {
    text: cleaned,
    changed: cleaned !== original.trim(),
  };
}

function rewriteMessageText(message, transform) {
  if (!isPlainRecord(message)) return message;
  let changed = false;
  const next = { ...message };

  if (typeof message.text === 'string') {
    const rewritten = transform(message.text);
    if (rewritten !== message.text) {
      next.text = rewritten;
      changed = true;
    }
  }

  if (typeof message.content === 'string') {
    const rewritten = transform(message.content);
    if (rewritten !== message.content) {
      next.content = rewritten;
      changed = true;
    }
  } else if (Array.isArray(message.content)) {
    const content = [];
    for (const part of message.content) {
      if (typeof part === 'string') {
        const rewritten = transform(part);
        if (rewritten !== part) changed = true;
        if (rewritten) content.push(rewritten);
        continue;
      }
      if (!isPlainRecord(part)) {
        content.push(part);
        continue;
      }
      let nextPart = part;
      if (typeof part.text === 'string') {
        const rewritten = transform(part.text);
        if (rewritten !== part.text) {
          nextPart = { ...nextPart, text: rewritten };
          changed = true;
        }
      }
      if (typeof part.content === 'string') {
        const rewritten = transform(part.content);
        if (rewritten !== part.content) {
          nextPart = { ...nextPart, content: rewritten };
          changed = true;
        }
      }
      const textOnlyPart = ['text', 'input_text', 'output_text'].includes(String(nextPart.type ?? '').toLowerCase());
      const textValues = [nextPart.text, nextPart.content].filter((value) => typeof value === 'string');
      if (textOnlyPart && textValues.length > 0 && textValues.every((value) => !value.trim())) continue;
      content.push(nextPart);
    }
    if (changed) next.content = content;
  }

  return changed ? next : message;
}

function sanitizeInternalTranscriptMessage(message) {
  if (!isPlainRecord(message)) return { action: 'keep', message };
  const role = String(message.role ?? '').toLowerCase();
  const originalText = extractMessageText(message).trim();
  if (!originalText) return { action: 'keep', message };

  resetRegex(DESIGNED_PRESENTATION_CONTRACT_RE);
  if (role === 'user' && DESIGNED_PRESENTATION_CONTRACT_RE.test(originalText)) {
    const rewritten = rewriteMessageText(message, (value) => value.replace(DESIGNED_PRESENTATION_CONTRACT_RE, '').trim());
    if (extractMessageText(rewritten).trim()) {
      return { action: 'rewrite', message: rewritten, reason: 'designed_presentation_contract_suffix' };
    }
    return { action: 'block', message, reason: 'designed_presentation_contract' };
  }

  resetRegex(GATEWAY_RESTART_CONTINUATION_RE);
  if ((role === 'user' || role === 'system') && GATEWAY_RESTART_CONTINUATION_RE.test(originalText)) {
    const rewritten = rewriteMessageText(message, (value) => stripGatewayRestartContinuationText(value).text);
    if (extractMessageText(rewritten).trim()) {
      return { action: 'rewrite', message: rewritten, reason: 'gateway_restart_continuation_suffix' };
    }
    return { action: 'block', message, reason: 'gateway_restart_continuation' };
  }

  const reason = classifyInternalTranscriptMessage(message);
  if (reason) return { action: 'block', message, reason };
  return { action: 'keep', message };
}

function sanitizePromptHistoryMessages(event) {
  const result = { blocked: 0, rewritten: 0, reasons: {} };
  const visited = new Set();
  for (const messages of extractMessageLists(event)) {
    if (visited.has(messages)) continue;
    visited.add(messages);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const decision = sanitizeInternalTranscriptMessage(messages[index]);
      if (decision.action === 'keep') continue;
      const reason = decision.reason ?? 'internal_runtime_message';
      result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
      if (decision.action === 'block') {
        messages.splice(index, 1);
        result.blocked += 1;
      } else {
        messages[index] = decision.message;
        result.rewritten += 1;
      }
    }
  }
  return result;
}

const DESIGNED_PRESENTATION_TOOL_RE = /(?:^|:)(?:create_designed_pptx_file|repair_designed_pptx_file)$/iu;

function compactPresentationInvocationArgs(toolName, rawArgs) {
  const wasString = typeof rawArgs === 'string';
  let args = rawArgs;
  if (wasString) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return { value: rawArgs, omittedChars: 0 };
    }
  }
  if (!isPlainRecord(args)) return { value: rawArgs, omittedChars: 0 };

  const directoryTarget = String(args.id ?? '');
  const effectiveToolName = DESIGNED_PRESENTATION_TOOL_RE.test(directoryTarget)
    ? directoryTarget
    : String(toolName ?? '');
  if (!DESIGNED_PRESENTATION_TOOL_RE.test(effectiveToolName)) {
    return { value: rawArgs, omittedChars: 0 };
  }

  const payload = isPlainRecord(args.args) ? args.args : args;
  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  const patches = Array.isArray(payload.patches) ? payload.patches : [];
  if (slides.length === 0 && patches.length === 0) return { value: rawArgs, omittedChars: 0 };

  const compactPayload = { ...payload };
  delete compactPayload.slides;
  delete compactPayload.patches;
  compactPayload.summarizedForModel = true;
  compactPayload.summaryKind = 'designed_presentation_invocation';
  if (slides.length > 0) {
    compactPayload.slideCount = slides.length;
    compactPayload.elementCount = slides.reduce(
      (count, slide) => count + (Array.isArray(slide?.elements) ? slide.elements.length : 0),
      0,
    );
  }
  if (patches.length > 0) compactPayload.patchCount = patches.length;

  const compactArgs = payload === args ? compactPayload : { ...args, args: compactPayload };
  const serialized = JSON.stringify(compactArgs);
  const omittedChars = Math.max(0, JSON.stringify(args).length - serialized.length);
  return { value: wasString ? serialized : compactArgs, omittedChars };
}

function compactHistoricalPresentationToolCalls(event) {
  const result = { compacted: 0, omittedChars: 0 };
  const visited = new Set();
  for (const messages of extractMessageLists(event)) {
    if (visited.has(messages)) continue;
    visited.add(messages);
    const latestUserIndex = latestUserMessageIndex(messages);
    const latestUserText = latestUserIndex >= 0 ? extractMessageText(messages[latestUserIndex]).trim() : '';
    const promptText = String(event?.prompt ?? '').trim();
    const currentPromptAlreadyInMessages = Boolean(
      latestUserText
      && promptText
      && (latestUserText === promptText || promptText.includes(latestUserText)),
    );
    const isFinalizeRevision = /Before accepting the previous final answer|UClaw artifact delivery final reply/iu.test(promptText);
    const historyEnd = latestUserIndex < 0
      ? messages.length
      : (currentPromptAlreadyInMessages || isFinalizeRevision ? latestUserIndex : messages.length);
    for (let index = 0; index < historyEnd; index += 1) {
      const message = messages[index];
      if (!isPlainRecord(message) || String(message.role ?? '').toLowerCase() !== 'assistant') continue;
      const containers = [];
      if (Array.isArray(message.content)) containers.push(...message.content.filter(isPlainRecord));
      const topLevelCalls = Array.isArray(message.tool_calls) ? message.tool_calls : message.toolCalls;
      if (Array.isArray(topLevelCalls)) containers.push(...topLevelCalls.filter(isPlainRecord));
      for (const container of containers) {
        const fn = isPlainRecord(container.function) ? container.function : container;
        const toolName = String(fn.name ?? container.name ?? '');
        for (const key of ['arguments', 'input']) {
          if (!(key in fn)) continue;
          const compacted = compactPresentationInvocationArgs(toolName, fn[key]);
          if (compacted.omittedChars <= 0) continue;
          fn[key] = compacted.value;
          result.compacted += 1;
          result.omittedChars += compacted.omittedChars;
        }
      }
    }
  }
  return result;
}

function inferRequestedArtifactKind(text) {
  const source = String(text ?? '');
  if (/(?:PPT|pptx?|演示文稿|幻灯片|deck|slides?)/iu.test(source)) return 'presentation';
  if (/(?:Word|docx?|文档|报告|标书|投标书|招投标书|方案|稿子|文章|内容|文案|小说|故事|长文|剧本|正文|novel|story|screenplay|manuscript|copy)/iu.test(source)) return 'document';
  if (/(?:Excel|xlsx?|表格|电子表格|工作簿|spreadsheet|workbook|csv|tsv)/iu.test(source)) return 'spreadsheet';
  if (/(?:PDF|pdf)/iu.test(source)) return 'pdf';
  if (/(?:视频|video|mp4|mov|webm)/iu.test(source)) return 'video';
  if (/(?:图片|图像|海报|插画|封面|照片|image|photo|png|jpe?g|webp|svg)/iu.test(source)) return 'image';
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

function parseJsonRecordText(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^[{[]/u.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function appendStructuredResultText(parts, result) {
  if (!isRecord(result)) return;
  for (const key of ['filePath', 'outputPath', 'output_path', 'path', 'out', 'url', 'mediaUrl', 'media_url']) {
    if (typeof result[key] === 'string') parts.push(`${key}: "${result[key]}"`);
  }
  for (const key of ['artifact', 'artifacts', 'output', 'outputs', 'files', 'media']) {
    const rendered = stringifyJson(result[key]);
    if (rendered) parts.push(rendered);
  }
}

function appendPossiblyJsonText(parts, value) {
  const parsed = parseJsonRecordText(value);
  if (parsed) appendStructuredResultText(parts, parsed);
  else parts.push(value);
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

function canonicalLocalPath(value, cwd) {
  const normalized = normalizeLocalPath(stripArtifactRef(value), cwd);
  if (!normalized) return undefined;
  const absolute = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd(), normalized);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function artifactRefDedupeKey(value, cwd) {
  const stripped = stripArtifactRef(value);
  if (isUrlRef(stripped)) {
    try {
      const url = new URL(stripped);
      url.hash = '';
      return url.toString();
    } catch {
      return stripped;
    }
  }
  return (canonicalLocalPath(stripped, cwd) ?? stripped).replace(/\\/gu, '/');
}

function countTextContentUnits(text) {
  const normalized = String(text ?? '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/^[\t ]{0,3}(?:#{1,6}|>|[-+*]\s|\d+[.)]\s)/gmu, '')
    .replace(/[`*_~\[\](){}]/gu, ' ');
  const characters = Array.from(normalized.replace(/\s+/gu, '')).length;
  const words = normalized
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
  return { characters, words };
}

function readArtifactTextMetrics(filePath) {
  if (!filePath || !TEXT_CONTENT_EXT_RE.test(filePath)) return undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_TEXT_CONTENT_BYTES) return undefined;
    return {
      ...countTextContentUnits(readFileSync(filePath, 'utf8')),
      sizeBytes: stat.size,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function inferArtifactKind(ref) {
  const clean = ref.toLowerCase().split('?')[0] ?? ref.toLowerCase();
  if (/\.(png|jpe?g|webp|svg)$/iu.test(clean)) return 'image';
  if (/\.(mp4|mov|webm)$/iu.test(clean)) return 'video';
  if (/\.(blend|glb|gltf|obj|fbx)$/iu.test(clean)) return 'model3d';
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
  if (/\.blend$/iu.test(clean)) return 'application/x-blender';
  if (/\.glb$/iu.test(clean)) return 'model/gltf-binary';
  if (/\.gltf$/iu.test(clean)) return 'model/gltf+json';
  if (/\.obj$/iu.test(clean)) return 'model/obj';
  if (/\.fbx$/iu.test(clean)) return 'model/fbx';
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
    const key = artifactRefDedupeKey(ref, event?.cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildArtifactEvidence(event, finalText, options = {}) {
  return extractArtifactRefs(event, finalText, options).map((ref) => {
    const url = isUrlRef(ref) ? ref : undefined;
    const filePath = canonicalLocalPath(ref, event?.cwd);
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
    return {
      ref,
      artifact,
      verification,
      textMetrics: readArtifactTextMetrics(filePath),
    };
  });
}

function extractToolResultText(result, depth = 0, seen = new Set()) {
  if (depth > 4 || result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (seen.has(result)) return '';
    seen.add(result);
  }
  const parts = [];
  appendStructuredResultText(parts, result);
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (typeof part === 'string') {
        appendPossiblyJsonText(parts, part);
      } else if (isRecord(part)) {
        if (typeof part.text === 'string') appendPossiblyJsonText(parts, part.text);
        if (typeof part.content === 'string') appendPossiblyJsonText(parts, part.content);
        if (typeof part.url === 'string') parts.push(part.url);
        if (typeof part.filePath === 'string') parts.push(`filePath: "${part.filePath}"`);
        if (typeof part.outputPath === 'string') parts.push(`outputPath: "${part.outputPath}"`);
      }
    }
  }
  parts.push(stringifyJson(result?.details));
  if (isRecord(result?.result)) parts.push(extractToolResultText(result.result, depth + 1, seen));
  if (isRecord(result?.meta)) parts.push(extractToolResultText(result.meta, depth + 1, seen));
  return parts.filter(Boolean).join('\n');
}

function extractPrimaryToolResultText(result) {
  if (typeof result === 'string') return result;
  if (!isRecord(result)) return '';

  const parts = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (typeof part === 'string') parts.push(part);
      else if (isRecord(part) && typeof part.text === 'string') parts.push(part.text);
    }
  }
  if (parts.length > 0) return parts.filter(Boolean).join('\n');

  for (const key of ['text', 'output', 'stdout']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key];
  }
  return '';
}

function countTextLines(value) {
  const text = String(value ?? '');
  if (!text) return 0;
  return text.split(/\r?\n/u).length;
}

function collectTranscriptBloatKinds(text) {
  const normalized = String(text ?? '');
  const kinds = [];
  if (TRANSCRIPT_BLOAT_SESSION_RE.test(normalized)) kinds.push('session/jsonl');
  if (TRANSCRIPT_BLOAT_TRAJECTORY_RE.test(normalized)) kinds.push('trajectory');
  if (TRANSCRIPT_BLOAT_LOG_RE.test(normalized)) kinds.push('log');
  return kinds;
}

function collectTranscriptBloatHints(value, hints = [], seen = new Set(), depth = 0) {
  if (depth > 2 || value === null || value === undefined) return hints;
  if (typeof value === 'string') {
    const normalized = truncateText(value, 180);
    if (
      normalized
      && (TRANSCRIPT_BLOAT_SESSION_RE.test(normalized)
        || TRANSCRIPT_BLOAT_TRAJECTORY_RE.test(normalized)
        || TRANSCRIPT_BLOAT_LOG_RE.test(normalized)
        || /(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/)/u.test(normalized))
    ) {
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hints.push(normalized);
      }
    }
    return hints;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      collectTranscriptBloatHints(item, hints, seen, depth + 1);
      if (hints.length >= TRANSCRIPT_BLOAT_MAX_HINTS) break;
    }
    return hints;
  }
  if (!isRecord(value)) return hints;
  const interestingKeys = [
    'args',
    'params',
    'result',
    'command',
    'cmd',
    'script',
    'path',
    'filePath',
    'outputPath',
    'output_path',
    'url',
    'mediaUrl',
    'media_url',
    'out',
    'file',
    'target',
    'source',
    'message',
    'error',
    'reason',
    'stdout',
    'stderr',
    'text',
    'content',
  ];
  for (const key of interestingKeys) {
    if (!(key in value)) continue;
    collectTranscriptBloatHints(value[key], hints, seen, depth + 1);
    if (hints.length >= TRANSCRIPT_BLOAT_MAX_HINTS) break;
  }
  return hints;
}

function collectStructuredArtifactRefsForTranscript(text) {
  const rawPathText = [MEDIA_ARTIFACT_PATH_RE, ARTIFACT_URL_RE, ARTIFACT_FIELD_RE].reduce(
    (result, regex) => result.replace(resetRegex(regex), ' '),
    text,
  );
  const refs = [
    ...collectRefsWithRegex(text, MEDIA_ARTIFACT_PATH_RE).map((ref) => `MEDIA:${ref}`),
    ...collectRefsWithRegex(text, ARTIFACT_URL_RE),
    ...collectRefsWithRegex(text, ARTIFACT_FIELD_RE),
    ...collectRefsWithRegex(rawPathText, ARTIFACT_PATH_RE),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const normalizedRef = stripArtifactRef(ref);
    if (!normalizedRef) return false;
    if (inferArtifactKind(normalizedRef) === 'file') return false;
    const key = artifactRefDedupeKey(normalizedRef);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TRANSCRIPT_BLOAT_MAX_ARTIFACT_REFS);
}

function buildTranscriptBloatSummary(meta) {
  const header = `已收敛高膨胀 ${meta.toolName || 'tool'} 结果（${meta.kinds.join(' / ') || '大块工具输出'}，${meta.lineCount} 行 / ${meta.charCount} 字符），模型可见 transcript 仅保留摘要。`;
  const lines = [header];
  if (meta.failure) lines.push(`结果摘要：${meta.failure}`);
  if (meta.hints.length > 0) lines.push(`目标线索：${meta.hints.join(' | ')}`);
  if (meta.artifactRefs.length > 0) lines.push(`保留产物证据：${meta.artifactRefs.join(' | ')}`);
  if (meta.excerpt) {
    lines.push('以下保留原始结果的首尾摘录，供当前任务继续判断：');
    lines.push(meta.excerpt);
  }
  lines.push('原始大段输出已省略；如需逐行排查，请继续针对目标文件或日志做 read / rg。');
  return lines.join('\n');
}

function buildLargeOutputExcerpt(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  const limit = TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS + TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS;
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, TRANSCRIPT_LARGE_OUTPUT_HEAD_CHARS);
  const tail = normalized.slice(-TRANSCRIPT_LARGE_OUTPUT_TAIL_CHARS);
  return `${head}\n\n... 已省略中间 ${normalized.length - limit} 个字符 ...\n\n${tail}`;
}

function compactToolResultDetailsForTranscript(rawDetails, meta) {
  const compact = {};
  if (isRecord(rawDetails)) {
    for (const key of ['status', 'ok', 'message', 'error', 'reason', 'filePath', 'outputPath', 'output_path', 'url', 'mediaUrl', 'media_url', 'out']) {
      const value = rawDetails[key];
      if (typeof value === 'string' && value.trim()) compact[key] = truncateText(value, 240);
      else if (typeof value === 'boolean' || typeof value === 'number') compact[key] = value;
    }
  }
  compact.summarizedForModel = true;
  compact.summaryKind = 'tool_result_transcript_compaction';
  compact.omittedChars = meta.charCount;
  compact.omittedLines = meta.lineCount;
  compact.categories = meta.kinds;
  if (meta.hints.length > 0) compact.hints = meta.hints;
  if (meta.artifactRefs.length > 0) compact.preservedArtifactRefs = meta.artifactRefs;
  return compact;
}

function compactToolResultContentForTranscript(content, summaryText) {
  const preservedParts = Array.isArray(content)
    ? content
      .filter((part) => isRecord(part) && (
        typeof part.url === 'string'
        || typeof part.filePath === 'string'
        || typeof part.outputPath === 'string'
        || typeof part.mediaUrl === 'string'
      ))
      .map((part) => {
        const compact = {};
        for (const key of ['type', 'url', 'filePath', 'outputPath', 'mediaUrl', 'mimeType', 'title', 'name']) {
          if (typeof part[key] === 'string' && part[key].trim()) compact[key] = part[key];
        }
        return Object.keys(compact).length > 0 ? compact : undefined;
      })
      .filter(Boolean)
    : [];
  return [
    { type: 'text', text: summaryText },
    ...preservedParts,
  ];
}

function cloneJsonCompatible(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (Array.isArray(value)) return value.map((item) => cloneJsonCompatible(item));
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      next[key] = cloneJsonCompatible(nestedValue);
    }
    return next;
  }
}

function summarizeToolResultForTranscript(event) {
  const toolName = normalizeToolName(event).toLowerCase();
  if (!toolName || !TRANSCRIPT_BLOAT_TOOL_RE.test(toolName)) return undefined;

  const resultText = extractToolResultText(event?.result);
  const charCount = resultText.length;
  const lineCount = countTextLines(resultText);
  if (!resultText.trim()) return undefined;

  // Classify from the invocation target only. Source code and configuration
  // output commonly contain words such as sessionKey, stdout, or console;
  // treating result text as a path signal discards the evidence the model just
  // requested and can leave the following model turn with no usable context.
  const classificationText = [
    stringifyJson(event?.args),
    stringifyJson(event?.params),
  ].filter(Boolean).join('\n');
  const kinds = collectTranscriptBloatKinds(classificationText);
  const hasTargetKind = kinds.length > 0;
  const tooLarge = charCount >= TRANSCRIPT_BLOAT_MIN_CHARS || lineCount >= TRANSCRIPT_BLOAT_MIN_LINES;
  const extremelyLarge = charCount >= TRANSCRIPT_BLOAT_EXTREME_CHARS || lineCount >= TRANSCRIPT_BLOAT_EXTREME_LINES;
  if (!(tooLarge && hasTargetKind) && !extremelyLarge) return undefined;

  const hints = collectTranscriptBloatHints({
    args: event?.args,
    params: event?.params,
    result: event?.result,
  }).slice(0, TRANSCRIPT_BLOAT_MAX_HINTS);
  const artifactRefs = hasTargetKind
    ? collectStructuredArtifactRefsForTranscript(resultText)
    : [];
  const failure = summarizeToolFailure(event);
  const excerpt = hasTargetKind
    ? ''
    : buildLargeOutputExcerpt(extractPrimaryToolResultText(event?.result) || resultText);
  const summaryText = buildTranscriptBloatSummary({
    toolName,
    kinds: hasTargetKind ? kinds : ['large-output'],
    charCount,
    lineCount,
    hints,
    artifactRefs,
    failure,
    excerpt,
  });

  if (typeof event?.result === 'string') {
    return {
      summaryText,
      result: summaryText,
      meta: {
        toolName,
        kinds: hasTargetKind ? kinds : ['large-output'],
        charCount,
        lineCount,
        hints,
        artifactRefs,
      },
    };
  }

  const nextResult = isRecord(event?.result) ? cloneJsonCompatible(event.result) : {};
  nextResult.content = compactToolResultContentForTranscript(nextResult.content, summaryText);
  nextResult.details = compactToolResultDetailsForTranscript(nextResult.details, {
    kinds: hasTargetKind ? kinds : ['large-output'],
    charCount,
    lineCount,
    hints,
    artifactRefs,
  });
  for (const key of ['text', 'output', 'stdout', 'stderr', 'log', 'logs', 'transcript', 'trajectory']) {
    if (typeof nextResult[key] === 'string' && nextResult[key].trim()) {
      nextResult[key] = summaryText;
    }
  }

  return {
    summaryText,
    result: nextResult,
    meta: {
      toolName,
      kinds: hasTargetKind ? kinds : ['large-output'],
      charCount,
      lineCount,
      hints,
      artifactRefs,
    },
  };
}

function isProducerToolName(toolName) {
  return PRODUCER_TOOL_RE.test(toolName ?? '');
}

function isSideEffectingProducerToolName(toolName) {
  const normalized = String(toolName ?? '').trim().toLowerCase();
  return SIDE_EFFECTING_PRODUCER_TOOL_RE.test(normalized)
    || normalized === 'apply_patch'
    || normalized === 'screenshot';
}

function hasGeneratedArtifactCue(text) {
  return GENERATED_ARTIFACT_CUE_RE.test(text);
}

function buildToolArtifactEvidence(event) {
  const resultText = extractToolResultText(event?.result);
  const toolName = normalizeToolName(event);
  // Media-tool args are source inputs, never generated-output evidence. In the
  // field failure, the rejected reference video was echoed in tool args and
  // could otherwise be mistaken for a newly generated video.
  const argsText = isProducerToolName(toolName) && !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
    ? stringifyJson(event?.args)
    : '';
  const text = [resultText, argsText].filter(Boolean).join('\n');
  if (!text.trim()) return [];
  return buildArtifactEvidence(
    { cwd: event?.cwd },
    text,
    {
      allowRawPaths: !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
        && (isProducerToolName(toolName) || hasGeneratedArtifactCue(text)),
    },
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

function delegatedToolResult(result) {
  const details = isRecord(result?.details) ? result.details : {};
  return isRecord(details.result) ? details.result : undefined;
}

function resultIndicatesError(result) {
  if (!isRecord(result)) return false;
  if (result.isError === true) return true;
  if (typeof result.error === 'string' && result.error.trim()) return true;
  if (result.ok === false || result.success === false) return true;
  if (typeof result.details?.error === 'string' && result.details.error.trim()) return true;
  if (result.details?.ok === false || result.details?.success === false) return true;
  const status = readToolStatus(result);
  return typeof status === 'string' && TOOL_ERROR_STATUS_RE.test(status);
}

function isToolError(event) {
  if (event?.isError === true) return true;
  if (typeof event?.error === 'string' && event.error.trim()) return true;
  return resultIndicatesError(event?.result)
    || resultIndicatesError(delegatedToolResult(event?.result));
}

function summarizeToolFailure(event) {
  const details = isRecord(event?.result?.details) ? event.result.details : {};
  const candidate = [
    details.error,
    details.message,
    details.reason,
    readToolStatus(event?.result),
  ].find((value) => typeof value === 'string' && value.trim());
  return candidate ? truncateText(redactProgressPreview(candidate), 180) : undefined;
}

function pruneToolEvidence(now = Date.now()) {
  for (const [runId, evidence] of toolEvidenceByRunId.entries()) {
    if (now - evidence.updatedAt > RUN_TOOL_EVIDENCE_TTL_MS) toolEvidenceByRunId.delete(runId);
  }
  while (toolEvidenceByRunId.size > RUN_TOOL_EVIDENCE_MAX_ENTRIES) {
    const oldestRunId = toolEvidenceByRunId.keys().next().value;
    if (!oldestRunId) break;
    toolEvidenceByRunId.delete(oldestRunId);
  }
}

function recordToolEvidence(event, ctx) {
  const runId = getRunId(event, ctx);
  const toolName = normalizeToolName(event);
  if (!runId || !toolName) return undefined;
  if (MEDIA_SIDE_EFFECT_TOOLS.has(toolName) && isSafeMediaToolReadAction(normalizeEffectiveToolParams(event))) {
    return undefined;
  }

  const failed = isToolError(event);
  const declaredContract = toolName === TURN_CONTRACT_TOOL_NAME && !failed
    ? normalizeDeclaredTurnContract(event)
    : undefined;
  const artifacts = failed ? [] : buildToolArtifactEvidence(event).map((entry) => ({
    ...entry,
    artifact: {
      ...entry.artifact,
      sourceRunId: runId,
      sourceToolCallId: normalizeOptionalString(event?.toolCallId),
      sourceToolName: toolName,
    },
    successfulToolResult: true,
    sourceRunId: runId,
    sourceToolCallId: normalizeOptionalString(event?.toolCallId),
    sourceToolName: toolName,
  }));
  if (
    !declaredContract
    && !failed
    && artifacts.length === 0
    && !MEDIA_SIDE_EFFECT_TOOLS.has(toolName)
  ) return undefined;

  const now = Date.now();
  pruneToolEvidence(now);
  const current = toolEvidenceByRunId.get(runId) ?? { updatedAt: now, attempts: [] };
  if (declaredContract) current.contract = declaredContract;
  const toolCallId = normalizeOptionalString(event?.toolCallId);
  const attempt = {
    runId,
    toolName,
    toolCallId,
    failed,
    artifacts,
    updatedAt: now,
  };
  const duplicateIndex = current.attempts.findIndex((item) => (
    toolCallId && item.toolCallId === toolCallId && item.toolName === toolName
  ));
  if (duplicateIndex >= 0) current.attempts[duplicateIndex] = attempt;
  else current.attempts.push(attempt);
  current.updatedAt = now;
  toolEvidenceByRunId.delete(runId);
  toolEvidenceByRunId.set(runId, current);
  pruneToolEvidence(now);
  return attempt;
}

function normalizeDeclaredTurnContract(event) {
  const params = normalizeEffectiveToolParams(event);
  const details = isRecord(event?.result?.details) ? event.result.details : {};
  const delegatedResult = delegatedToolResult(event?.result);
  const delegatedDetails = isRecord(delegatedResult?.details) ? delegatedResult.details : {};
  const resultContract = isRecord(details.contract)
    ? details.contract
    : isRecord(delegatedDetails.contract)
      ? delegatedDetails.contract
      : undefined;
  const candidate = resultContract ?? params;
  if (!isRecord(candidate)) return undefined;

  const intent = normalizeOptionalString(candidate.intent);
  const sideEffect = normalizeOptionalString(candidate.sideEffect);
  const toolRequirement = normalizeOptionalString(candidate.toolRequirement);
  const acceptance = isRecord(candidate.acceptance) ? candidate.acceptance : {};
  if (!intent || !sideEffect || !toolRequirement) return undefined;

  return {
    intent,
    sideEffect,
    toolRequirement,
    sideEffectAuthorized: candidate.sideEffectAuthorized === true,
    capabilityRefs: Array.isArray(candidate.capabilityRefs)
      ? candidate.capabilityRefs.filter((value) => typeof value === 'string' && value.trim()).slice(0, 32)
      : [],
    acceptance: {
      requiresArtifact: acceptance.requiresArtifact === true,
      requiresVerification: acceptance.requiresVerification === true,
      requiresApproval: acceptance.requiresApproval === true,
      requiresToolEvidence: acceptance.requiresToolEvidence === true,
    },
  };
}

function getToolEvidenceForRun(runId) {
  if (!runId) return { updatedAt: 0, attempts: [] };
  pruneToolEvidence();
  return toolEvidenceByRunId.get(runId) ?? { updatedAt: 0, attempts: [] };
}

function findSuccessfulToolArtifact(entry, runToolEvidence) {
  const entryKeys = new Set(artifactIdentityKeys(entry));
  for (const attempt of runToolEvidence?.attempts ?? []) {
    if (attempt.failed) continue;
    for (const toolArtifact of attempt.artifacts ?? []) {
      if (artifactIdentityKeys(toolArtifact).some((key) => entryKeys.has(key))) {
        return toolArtifact;
      }
    }
  }
  return undefined;
}

function successfulMediaCompletionTool(runId) {
  const match = /^(image_generate|video_generate):[^:]+:ok$/iu.exec(String(runId ?? ''));
  return match?.[1]?.toLowerCase();
}

function successfulMediaCompletionKind(runId) {
  const toolName = successfulMediaCompletionTool(runId);
  if (toolName === 'image_generate') return 'image';
  if (toolName === 'video_generate') return 'video';
  return undefined;
}

function bindArtifactsToCurrentRunToolEvidence(artifacts, runToolEvidence, runId) {
  const completionTool = successfulMediaCompletionTool(runId);
  return artifacts.map((entry) => {
    const matched = findSuccessfulToolArtifact(entry, runToolEvidence);
    const completionKindMatches = completionTool === 'video_generate'
      ? entry?.artifact?.kind === 'video'
      : completionTool === 'image_generate' && entry?.artifact?.kind === 'image';
    if (!matched && !completionKindMatches) return entry;
    const sourceRunId = matched?.sourceRunId ?? runId;
    const sourceToolCallId = matched?.sourceToolCallId;
    const sourceToolName = matched?.sourceToolName ?? completionTool;
    return {
      ...entry,
      successfulToolResult: true,
      sourceRunId,
      sourceToolCallId,
      sourceToolName,
      artifact: {
        ...entry.artifact,
        sourceRunId,
        sourceToolCallId,
        sourceToolName,
      },
    };
  });
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
    textLength: params.textLength,
    requiresToolEvidence: params.requiresToolEvidence === true,
    allowImplicitMediaToolEvidence: params.allowImplicitMediaToolEvidence !== false,
    requiresVerification: params.requiresVerification !== false,
    required: true,
    source: RUNTIME_EVENT_SOURCE,
  };
}

function deriveRequiredEffects({
  activeUserText,
  artifactRequest,
  artifactRevisionRequest,
  completionArtifactKind,
  textLengthRequirement,
  priorArtifacts,
  desktopActionRequest,
  compositeRequiredArtifactCount,
  declaredContract,
  runToolEvidence,
  requireCurrentRunToolEvidence,
}) {
  const effects = [];
  const textLength = textLengthRequirement ?? requestedTextLength(activeUserText);
  if (declaredContract) {
    if (artifactRequest) {
      const target = artifactRevisionRequest ? priorArtifacts.at(-1) : undefined;
      effects.push(makeRequiredEffect({
        type: artifactRevisionRequest ? 'create_artifact_revision' : 'create_artifact',
        intent: declaredContract.intent || 'artifact_delivery',
        kind: inferContractArtifactKind(declaredContract, runToolEvidence),
        title: artifactRevisionRequest ? '产物修订' : '产物交付',
        minCount: 1,
        mustBeNewArtifact: artifactRevisionRequest,
        targetArtifactId: target?.artifact?.id,
        targetArtifactRef: target?.ref,
        targetArtifactKeys: target ? artifactIdentityKeys(target) : undefined,
        textLength,
        requiresToolEvidence: declaredContract.acceptance?.requiresToolEvidence === true,
        allowImplicitMediaToolEvidence: false,
        requiresVerification: declaredContract.acceptance?.requiresVerification === true,
      }));
    }
    if (desktopActionRequest) {
      effects.push(makeRequiredEffect({
        type: 'external_action',
        intent: declaredContract.intent || 'external_action',
        kind: 'desktop_or_message',
        title: '桌面或外部消息动作',
        minCount: 1,
      }));
    }
    return effects;
  }

  const rawCompositeDetectors = matchRawCompositeArtifactDetectors(activeUserText);
  const compositeCount = Math.max(compositeRequiredArtifactCount, rawCompositeDetectors.length);

  if (artifactRevisionRequest) {
    const target = priorArtifacts.at(-1);
    effects.push(makeRequiredEffect({
      type: 'create_artifact_revision',
      intent: 'artifact_revision',
      kind: completionArtifactKind ?? inferRequestedArtifactKind(activeUserText) ?? target?.artifact?.kind,
      title: '产物修订',
      minCount: 1,
      mustBeNewArtifact: true,
      targetArtifactId: target?.artifact?.id,
      targetArtifactRef: target?.ref,
      targetArtifactKeys: target ? artifactIdentityKeys(target) : undefined,
      textLength,
      requiresToolEvidence: requireCurrentRunToolEvidence,
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
          textLength: detector.kind === 'document' ? textLength : undefined,
          requiresToolEvidence: requireCurrentRunToolEvidence,
        }));
      });
      for (let index = effects.length; index < compositeCount; index += 1) {
        effects.push(makeRequiredEffect({
          type: 'create_artifact',
          intent: 'composite_artifact',
          title: `组合产物 ${index + 1}`,
          index: index + 1,
          minCount: 1,
          requiresToolEvidence: requireCurrentRunToolEvidence,
        }));
      }
    } else {
      effects.push(makeRequiredEffect({
        type: 'create_artifact',
        intent: 'artifact_delivery',
        kind: completionArtifactKind ?? inferRequestedArtifactKind(activeUserText),
        title: '产物交付',
        minCount: 1,
        textLength,
        requiresToolEvidence: requireCurrentRunToolEvidence,
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

function inferContractArtifactKind(contract, runToolEvidence) {
  const toolNames = (runToolEvidence?.attempts ?? []).map((attempt) => attempt.toolName);
  const refs = [...(contract?.capabilityRefs ?? []), ...toolNames].join(' ').toLowerCase();
  if (/video_generate|video/.test(refs)) return 'video';
  if (/image_generate|image/.test(refs)) return 'image';
  if (/pptx|presentation|slide/.test(refs)) return 'presentation';
  if (/xlsx|spreadsheet|excel/.test(refs)) return 'spreadsheet';
  if (/docx|document|word/.test(refs)) return 'document';
  if (/html|webpage|web_app/.test(refs)) return 'webpage';
  if (/blend|blender|glb|gltf/.test(refs)) return 'model';
  return undefined;
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

function effectRequiresCurrentRunToolEvidence(effect, evidence) {
  if (effect?.requiresToolEvidence === true) return true;
  if (effect?.allowImplicitMediaToolEvidence === false) return false;
  if (effect?.kind !== 'image' && effect?.kind !== 'video') return false;
  return Boolean(
    evidence?.enforceCurrentRunToolEvidence
    || (evidence?.runToolEvidence?.attempts ?? []).some((attempt) => MEDIA_SIDE_EFFECT_TOOLS.has(attempt.toolName)),
  );
}

const UNAUTHORIZED_CONTRACT_SAFE_TOOLS = new Set([
  TURN_CONTRACT_TOOL_NAME,
  'read',
  'file_read',
  'tool_search',
  'tool_describe',
  'web_search',
  'web_fetch',
  'uclaw_get_runtime_capabilities',
  'uclaw_get_task_bridge_capabilities',
  'uclaw_get_host_task',
  'uclaw_list_host_tasks',
  'tasks.get',
  'tasks.list',
]);

function canonicalAuthorizationToolName(event) {
  const direct = normalizeToolName(event).trim().toLowerCase();
  return direct.includes(':') ? direct.split(':').at(-1) : direct;
}

function nativeMediaPromptLengthBlock(event) {
  const toolName = canonicalAuthorizationToolName(event);
  if (!NATIVE_MEDIA_GENERATION_TOOLS.has(toolName)) return undefined;
  const prompt = normalizeEffectiveToolParams(event).prompt;
  if (typeof prompt !== 'string') return undefined;
  const characterCount = Array.from(prompt).length;
  if (characterCount <= NATIVE_MEDIA_PROMPT_MAX_CHARACTERS) return undefined;
  return {
    toolName,
    characterCount,
    reason: `${toolName} prompt exceeds the unified ${NATIVE_MEDIA_PROMPT_MAX_CHARACTERS}-character limit (${characterCount}). Shorten the prompt before retrying.`,
  };
}

function isSideEffectFreeToolInvocation(event) {
  const toolName = canonicalAuthorizationToolName(event);
  const action = normalizeToolAction(normalizeEffectiveToolParams(event));
  if (action) return SIDE_EFFECT_FREE_TOOL_ACTIONS.has(action);
  return SIDE_EFFECT_FREE_TOOL_NAME_RE.test(toolName)
    && !TERMINAL_SIDE_EFFECT_ACTION_RE.test(toolName);
}

function knownToolSideEffect(event) {
  const toolName = canonicalAuthorizationToolName(event);
  if (!toolName || UNAUTHORIZED_CONTRACT_SAFE_TOOLS.has(toolName)) return undefined;
  if (isSideEffectFreeToolInvocation(event)) return undefined;
  if (MEDIA_SIDE_EFFECT_TOOLS.has(toolName)) {
    if (NATIVE_MEDIA_GENERATION_TOOLS.has(toolName)) return 'remote_generation';
  }
  if (EXTERNAL_ACTION_TOOL_RE.test(toolName)) return 'external_action';
  if (REMOTE_GENERATION_TOOL_RE.test(toolName)) return 'remote_generation';
  if (isSideEffectingProducerToolName(toolName)) return 'local_artifact';
  if (['message', 'channel', 'wechat', 'openclaw-weixin'].includes(toolName)) {
    return 'external_action';
  }
  return undefined;
}

function knownSideEffectTool(event) {
  const toolName = canonicalAuthorizationToolName(event);
  if (toolName === 'uclaw_start_host_task') {
    const kind = normalizeOptionalString(normalizeEffectiveToolParams(event).kind)?.toLowerCase();
    return !kind || !SIDE_EFFECT_FREE_HOST_TASK_CAPABILITIES.has(kind);
  }
  return Boolean(
    knownToolSideEffect(event)
    || ['uclaw_cancel_host_task', 'uclaw_recover_host_task'].includes(toolName),
  );
}

function undeclaredSideEffectBlock(event, ctx) {
  const runId = getRunId(event, ctx);
  if (!runId || getToolEvidenceForRun(runId).contract || !knownSideEffectTool(event)) return undefined;
  const toolName = canonicalAuthorizationToolName(event);
  return {
    toolName,
    reason: `Declare the UClaw turn contract before executing side-effecting tool ${toolName}. This tool call was not executed.`,
  };
}

function contractSideEffectMismatchBlock(event, ctx) {
  const runId = getRunId(event, ctx);
  if (!runId || !knownSideEffectTool(event)) return undefined;
  const contract = getToolEvidenceForRun(runId).contract;
  if (!contract) return undefined;
  const actualSideEffect = knownToolSideEffect(event);
  const mismatch = contract.sideEffect === 'none'
    || (actualSideEffect && actualSideEffect !== contract.sideEffect);
  if (!mismatch) return undefined;
  const toolName = canonicalAuthorizationToolName(event);
  return {
    toolName,
    declaredSideEffect: contract.sideEffect,
    actualSideEffect,
    reason: `Tool ${toolName} has side effect ${actualSideEffect ?? 'side_effecting'}, but the turn contract declares ${contract.sideEffect}. Declare a matching authorized contract before retrying. This tool call was not executed.`,
  };
}

function unauthorizedSideEffectBlock(event, ctx) {
  const runId = getRunId(event, ctx);
  if (!runId) return undefined;
  const contract = getToolEvidenceForRun(runId).contract;
  if (!contract || contract.sideEffect === 'none' || contract.sideEffectAuthorized === true) return undefined;
  const toolName = canonicalAuthorizationToolName(event);
  if (UNAUTHORIZED_CONTRACT_SAFE_TOOLS.has(toolName)) return undefined;
  if (isSideEffectFreeToolInvocation(event)) return undefined;
  if (MEDIA_SIDE_EFFECT_TOOLS.has(toolName) && isSafeMediaToolReadAction(normalizeEffectiveToolParams(event))) {
    return undefined;
  }
  if (['message', 'channel', 'wechat', 'openclaw-weixin'].includes(toolName)) {
    const action = normalizeToolAction(normalizeEffectiveToolParams(event));
    if (action && ['get', 'list', 'read', 'search', 'status'].includes(action)) return undefined;
  }
  return {
    toolName,
    sideEffect: contract.sideEffect,
    reason: `User authorization is required before executing the declared ${contract.sideEffect} side effect. Do not retry this tool until the user explicitly authorizes it.`,
  };
}

function artifactSatisfiesEffect(effect, entry, usedArtifactIds, evidence) {
  const artifact = entry?.artifact;
  if (!artifact?.id || usedArtifactIds.has(artifact.id)) return false;
  // Availability is an authenticity baseline, not an optional quality check.
  if (entry?.verification?.status !== 'passed') return false;
  if (artifact.url && entry?.successfulToolResult !== true) return false;
  if (!artifactKindSatisfies(effect.kind, artifact.kind)) return false;
  if (effect.textLength) {
    const actual = entry?.textMetrics?.[effect.textLength.unit];
    if (!Number.isFinite(actual)) return false;
    if (effect.textLength.min !== undefined && actual < effect.textLength.min) return false;
    if (effect.textLength.max !== undefined && actual > effect.textLength.max) return false;
  }
  if (effectRequiresCurrentRunToolEvidence(effect, evidence) && entry?.successfulToolResult !== true) {
    return false;
  }
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
      if (!artifactSatisfiesEffect(effect, entry, usedArtifactIds, evidence)) continue;
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
        : effect.textLength
          ? `缺少满足文本长度要求的可读产物证据（${effect.textLength.unit}，目标 ${effect.textLength.target}）。`
        : effectRequiresCurrentRunToolEvidence(effect, evidence)
          ? '当前运行缺少由成功工具结果产生的同类型产物证据。'
          : effect.requiresVerification
            ? '缺少满足 effect 的产物证据或可用性验证未通过。'
          : effect.mustBeNewArtifact
            ? '缺少 latest user 之后产生的非覆盖新产物证据。'
            : '缺少满足 effect 的产物证据。',
    };
  });
}

function isExplicitBlocker(finalText) {
  const narrativeText = removeArtifactRefsFromText(finalText);
  return BLOCKER_RE.test(narrativeText) && !CONTINUATION_RE.test(narrativeText);
}

function analyzeArtifactFinal(event, ctx) {
  const userText = extractUserRequestText(event);
  const latestUserText = extractLatestUserRequestText(event);
  const activeUserText = latestUserText || userText;
  const finalText = extractFinalAssistantText(event);
  const emptyFinal = !finalText.trim();
  const heartbeatPoll = isHeartbeatPoll(activeUserText);
  const heartbeatOk = isHeartbeatOk(finalText);
  const { before: eventBeforeLatestUser, after: eventAfterLatestUser } = splitEventMessagesAroundLatestUser(event);
  const priorArtifacts = buildArtifactEvidence(eventBeforeLatestUser, '');
  const priorArtifactEvidence = priorArtifacts.length > 0 || hasArtifactEvidence(eventBeforeLatestUser, '');
  const currentRunId = getRunId(event, ctx);
  const completionArtifactKind = successfulMediaCompletionKind(currentRunId);
  const runToolEvidence = getToolEvidenceForRun(currentRunId);
  const declaredContract = runToolEvidence.contract;
  const enforceCurrentRunToolEvidence = Boolean(ctx && currentRunId);
  const legacySemanticFallback = !enforceCurrentRunToolEvidence;
  const explicitBlocker = isExplicitBlocker(finalText);
  const promiseOnly = PROMISE_ONLY_RE.test(finalText);
  // A new turn may omit a fresh contract even though the assistant itself
  // explicitly admits that the previously delivered artifact is unfinished.
  // This is a delivery fail-safe based on structured transcript evidence and
  // the assistant's own completion claim, not a user-phrase routing shortcut.
  const artifactContinuationPromise = Boolean(
    enforceCurrentRunToolEvidence
    && !declaredContract
    && priorArtifactEvidence
    && promiseOnly
    && UNFINISHED_ARTIFACT_ADMISSION_RE.test(finalText)
    && !ARTIFACT_CONTINUATION_NEGATION_RE.test(activeUserText)
    && !explicitBlocker
  );
  const artifactRevisionFeedback = isArtifactRevisionFeedback(activeUserText);
  const contractRequiresArtifact = Boolean(
    declaredContract?.acceptance?.requiresArtifact
    || declaredContract?.sideEffect === 'local_artifact'
    || declaredContract?.sideEffect === 'remote_generation'
  );
  const artifactRevisionRequest = Boolean(
    priorArtifactEvidence
    && (
      contractRequiresArtifact && artifactRevisionFeedback
      || artifactContinuationPromise
    )
  );
  const compositeRequiredArtifactCount = legacySemanticFallback
    ? countCompositeRequiredArtifacts(activeUserText)
    : 0;
  const rawCompositeRequiredArtifactCount = legacySemanticFallback
    ? countRawCompositeRequiredArtifacts(activeUserText)
    : 0;
  const inferredRequiredArtifactCount = Math.max(compositeRequiredArtifactCount, rawCompositeRequiredArtifactCount);
  const producerAttempted = runToolEvidence.attempts.some((attempt) => (
    isProducerToolName(attempt.toolName) || MEDIA_SIDE_EFFECT_TOOLS.has(attempt.toolName)
  ));
  // This is a delivery-only fail-safe, never a routing or tool authorization
  // decision. The Agent owns semantics through the turn contract; if it skips
  // both the contract and execution, the existing high-confidence detector may
  // only prevent an unsupported "completed" reply from escaping.
  const undeclaredExecutionRequest = Boolean(
    enforceCurrentRunToolEvidence
    && !declaredContract
    && isUndeclaredArtifactDeliveryRequest(activeUserText),
  );
  const artifactRequest = declaredContract
    ? contractRequiresArtifact
    : legacySemanticFallback
      ? isArtifactRequest(activeUserText) || inferredRequiredArtifactCount > 0 || artifactRevisionRequest
      : Boolean(completionArtifactKind) || producerAttempted || undeclaredExecutionRequest || artifactContinuationPromise;
  const textLengthRequirement = artifactRequest ? requestedTextLength(activeUserText) : undefined;
  const desktopActionRequest = declaredContract
    ? declaredContract.sideEffect === 'external_action'
    : legacySemanticFallback && isDesktopActionRequest(activeUserText);
  const approvalRequired = declaredContract?.acceptance?.requiresApproval === true;
  const authorizationMissing = Boolean(
    declaredContract
    && declaredContract.sideEffect !== 'none'
    && declaredContract.sideEffectAuthorized !== true
  );
  const artifacts = bindArtifactsToCurrentRunToolEvidence(
    buildArtifactEvidence(eventAfterLatestUser, finalText),
    runToolEvidence,
    currentRunId,
  );
  const finalArtifacts = buildArtifactEvidence({ cwd: event?.cwd }, finalText);
  const artifactEvidence = artifacts.length > 0 || hasArtifactEvidence(eventAfterLatestUser, finalText);
  const finalArtifactEvidence = finalArtifacts.length > 0 || hasArtifactEvidence({ cwd: event?.cwd }, finalText);
  const desktopActionEvidence = hasDesktopActionEvidence(event, finalText);
  const requiredEffects = deriveRequiredEffects({
    activeUserText,
    artifactRequest,
    artifactRevisionRequest,
    completionArtifactKind,
    textLengthRequirement,
    priorArtifacts,
    desktopActionRequest,
    compositeRequiredArtifactCount,
    declaredContract,
    runToolEvidence,
    requireCurrentRunToolEvidence: enforceCurrentRunToolEvidence,
  });
  const effectResults = evaluateRequiredEffects(requiredEffects, {
    artifacts,
    desktopActionEvidence,
    runToolEvidence,
    enforceCurrentRunToolEvidence,
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
  const artifactRepairPromise = artifactRequest && promiseOnly && ARTIFACT_REPAIR_PROMISE_CUE_RE.test(finalText);
  const unfinishedArtifactPromise = Boolean(
    artifactRequest
    && promiseOnly
    && (missingArtifactEffects.length > 0 || artifactRepairPromise),
  );
  const artifactVerificationRequired = requiredEffects.some((effect) => (
    (effect.type === 'create_artifact' || effect.type === 'create_artifact_revision')
    && effect.requiresVerification === true
  ));
  const unresolvedFinalVerificationBlock = Boolean(
    artifactRequest
    && artifactVerificationRequired
    && finalVerificationBlocked
    && !finalVerificationPassed,
  );
  const shouldReviseAuthorization = Boolean(
    userText.trim()
    && authorizationMissing
    && !explicitBlocker,
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
    && !heartbeatOk,
  );
  const shouldReviseEmptyFinal = Boolean(
    activeUserText.trim()
    && !heartbeatPoll
    && emptyFinal,
  );
  const shouldRevise = shouldReviseHeartbeat
    || shouldReviseEmptyFinal
    || shouldReviseAuthorization
    || shouldReviseArtifact
    || shouldReviseDesktopAction;
  return {
    userText,
    latestUserText,
    activeUserText,
    finalText,
    emptyFinal,
    heartbeatPoll,
    heartbeatOk,
    artifactRequest,
    declaredContract,
    legacySemanticFallback,
    artifactRevisionFeedback,
    artifactRevisionRequest,
    artifactContinuationPromise,
    completionArtifactKind,
    currentRunId,
    enforceCurrentRunToolEvidence,
    currentRunToolAttemptCount: runToolEvidence.attempts.length,
    currentRunFailedToolCount: runToolEvidence.attempts.filter((attempt) => attempt.failed).length,
    currentRunSuccessfulArtifactCount: runToolEvidence.attempts.reduce(
      (total, attempt) => total + (attempt.failed ? 0 : attempt.artifacts.length),
      0,
    ),
    priorArtifactEvidence,
    priorArtifactCount: priorArtifacts.length,
    desktopActionRequest,
    approvalRequired,
    authorizationMissing,
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
    shouldReviseEmptyFinal,
    shouldReviseAuthorization,
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
  if (analysis?.shouldReviseEmptyFinal) {
    return {
      action: 'revise',
      reason: 'UClaw run ended without a user-visible final response.',
      retry: {
        idempotencyKey: `${REVISION_ID}:empty-final`,
        maxAttempts: 1,
        instruction: [
          '上一轮已经结束，但没有生成任何用户可见的最终回复。现在只补写最终交付，不要沉默。',
          '优先依据本轮已有工具结果、产物和验证事实作答；不要重复执行已经成功的外部动作、文件生成、图片生成或视频生成。',
          '如果已有证据足够，直接用简体中文给出结论、完成项和必要限制。',
          '如果已有工具结果不足或失败，明确说明实际尝试、失败点和下一步，不要假装完成。',
        ].join('\n'),
      },
    };
  }
  if (analysis?.shouldReviseAuthorization) {
    return {
      action: 'revise',
      reason: 'UClaw turn contract has no user authorization for the declared side effect.',
      retry: {
        idempotencyKey: `${REVISION_ID}:side-effect-authorization`,
        maxAttempts: 1,
        instruction: [
          '本轮合同声明了副作用，但没有记录用户授权，因此不能声称已经完成，也不能在补偿轮继续或重试该副作用。',
          '请用简体中文明确说明尚未执行，并向用户说明将发生的副作用、影响对象和必要风险，然后请求用户确认。',
          '不要伪造审批、工具结果、产物路径或完成状态。',
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
    const lengthEffect = analysis.requiredEffects?.find((effect) => effect.textLength)?.textLength;
    return {
      action: 'revise',
      reason: 'UClaw artifact revision final reply had no new completed artifact evidence.',
      retry: {
        idempotencyKey: `${REVISION_ID}:artifact-revision`,
        maxAttempts: 2,
        instruction: [
          '当前轮是在修订上一轮产物，或者上一回复已经明确承认该产物尚未满足验收条件。',
          '不要只说“我会重做/我直接重做/我来优化”；现在必须继续执行，定位上一轮 MEDIA 路径或最近产物，创建一个新的非覆盖改进版。',
          '优先使用可用的 create_* 文件工具或相关 skill；如果没有专用工具，就用 exec 结合 Node/Python/uv 读取旧产物信息并重新生成。',
          '生成后必须用可用工具验证新文件存在，并在最终回复中返回新的 MEDIA:<absolute-path> 或新的绝对文件路径。',
          ...(lengthEffect ? [`最终文本必须读取复核，${lengthEffect.unit === 'words' ? '词数' : '字符数'}不得低于 ${lengthEffect.min ?? 1}${lengthEffect.max ? `，且不得超过 ${lengthEffect.max}` : ''}；不足时继续补写，不能只交付提纲、序章或片段。`] : []),
          '如果确实无法继续，最终回复必须说明已经尝试的路径、具体缺失能力或阻塞点。',
        ].join('\n'),
      },
    };
  }
  const lengthEffect = analysis?.requiredEffects?.find((effect) => effect.textLength)?.textLength;
  const forcePresentationTool = analysis?.missingRequiredEffects?.some(
    (result) => result?.effect?.kind === 'presentation',
  );
  return {
    action: 'revise',
    reason: REVISION_REASON,
    retry: {
      idempotencyKey: REVISION_ID,
      maxAttempts: 3,
      instruction: [
        '用户要的是真实本地产物，不要用“我会生成/我将处理/接下来我会”这类未来承诺结束。',
        '现在继续执行：优先使用可用的 create_* 文件工具或相关 skill；如果没有专用工具，就用 exec 结合 Node/Python/uv 临时构造执行路径。',
        ...(forcePresentationTool ? ['本次补偿轮优先直接调用 create_designed_pptx_file；如果质量门禁已经返回 repairToken，则调用 repair_designed_pptx_file 并只提交出错元素或页面的替换补丁。如果当前只暴露目录工具，先用 tool_describe 获取准确 schema，再通过 tool_call 执行，禁止猜测参数名。'] : []),
        '如果当前任务是 PPT/PPTX，本次修订必须实际调用 create_designed_pptx_file 或 repair_designed_pptx_file；禁止再次只做工具搜索、素材搜索、读取说明或描述“即将渲染”。已有素材应直接复用，缺少素材也要在本次修订内完成准备并紧接着调用生成工具。',
        '生成后必须用可用工具验证文件存在，并在最终回复中返回 MEDIA:<absolute-path> 或绝对文件路径。',
        ...(lengthEffect ? [`最终文本必须读取复核，${lengthEffect.unit === 'words' ? '词数' : '字符数'}不得低于 ${lengthEffect.min ?? 1}${lengthEffect.max ? `，且不得超过 ${lengthEffect.max}` : ''}；不足时继续补写，不能只交付提纲、序章或片段。`] : []),
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
  if (!analysis.artifactRequest && !analysis.desktopActionRequest && !analysis.authorizationMissing) return;
  if (analysis.authorizationMissing) {
    const issue = buildGateIssue(event, {
      code: 'side_effect.unauthorized',
      title: '副作用尚未获得用户授权',
      detail: reason,
      targetId: getRunId(event) ?? eventId(event),
      recoverable: false,
      suggestedRecovery: '先向用户说明副作用和影响并取得明确确认，再重新执行；当前不能声称已经完成。',
    });
    emitGateIssue(api, event, issue);
    emitRuntimeEvent(api, event, 'checkpoint', {
      checkpointId: `checkpoint:${getRunId(event) ?? eventId(event)}:side-effect-authorization`,
      summary: '本轮副作用尚未获得用户授权。',
      reason,
      recoverable: false,
      issues: [issue],
      suggestedRecovery: issue.suggestedRecovery,
      source: RUNTIME_EVENT_SOURCE,
    });
    return;
  }
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
  const toolName = normalizeToolName(event);
  return {
    id: event?.toolCallId ? `tool:${event.toolCallId}` : `tool:${hashString(toolName || 'unknown')}`,
    title: toolName ? `工具 ${toolName}` : '工具执行',
    status,
    kind: 'tool',
    detail: statusDetail ? `status=${statusDetail}` : undefined,
  };
}

function summarizeProgressCommand(command) {
  const candidate = String(command ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^(?:set\s+-[A-Za-z]+|printf\b|echo\b|#|true$|false$)/u.test(line));
  return truncateText(redactProgressPreview(candidate || String(command ?? '')), 160);
}

function redactProgressPreview(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, '[REDACTED]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|sess-[A-Za-z0-9_-]{8,})\b/gu, '[REDACTED]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s\/@]+(@)/gu, '$1[REDACTED]$2')
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/((?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gimu, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|signature|sig|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY))["']?\s*[:=]\s*["'])[^"'\r\n]*(["'])/giu, '$1[REDACTED]$2')
    .replace(/((?:^|[\s{[(,;])(?:export\s+)?(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY)|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)\s*=\s*)[^\s,;)}\]]+/gimu, '$1[REDACTED]')
    .replace(/([?&#](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|signature|sig|secret|credential|x-amz-credential|x-amz-signature)=)[^&#\s"']*/giu, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)(?:=|\s+))["']?[^\s"']+["']?/giu, '$1[REDACTED]');
}

function extractProgressPathLike(params) {
  for (const key of ['path', 'filePath', 'url']) {
    if (typeof params?.[key] === 'string' && params[key].trim()) {
      return truncateText(redactProgressPreview(params[key].trim()), 160);
    }
  }
  return undefined;
}

function parseProgressRecord(value) {
  if (isPlainRecord(value)) {
    if (typeof value.summary === 'string') {
      const parsed = parseProgressRecord(value.summary);
      if (parsed) return parsed;
    }
    if (Array.isArray(value.content)) {
      for (const part of value.content) {
        if (!isPlainRecord(part) || typeof part.text !== 'string') continue;
        const parsed = parseProgressRecord(part.text);
        if (parsed) return parsed;
      }
    }
    return value;
  }
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function progressResultEnvelope(event) {
  return parseProgressRecord(event?.result) ?? parseProgressRecord(event?.meta);
}

function progressDelegatedResult(event) {
  const envelope = progressResultEnvelope(event);
  return isPlainRecord(envelope?.result) ? envelope.result : envelope;
}

function progressResultDetails(event) {
  const envelope = progressResultEnvelope(event);
  const delegated = progressDelegatedResult(event);
  return isPlainRecord(delegated?.details)
    ? delegated.details
    : isPlainRecord(envelope?.details)
      ? envelope.details
      : {};
}

function progressToolLabel(event, toolName) {
  const envelope = progressResultEnvelope(event);
  const delegated = progressDelegatedResult(event);
  const tool = isPlainRecord(envelope?.tool)
    ? envelope.tool
    : isPlainRecord(delegated?.tool)
      ? delegated.tool
      : undefined;
  const structuredLabel = normalizeOptionalString(tool?.label)
    ?? normalizeOptionalString(tool?.title)
    ?? String(toolName ?? '').replace(/[_-]+/gu, ' ').trim();
  return truncateText(redactProgressPreview(structuredLabel || 'tool'), 120);
}

function mediaProgressSummary(params, details = {}) {
  const values = { ...params, ...details };
  const parts = [];
  if (Number.isFinite(values.durationSeconds)) parts.push(`${Math.max(1, Math.round(values.durationSeconds))}s`);
  const size = normalizeOptionalString(values.size);
  const resolution = normalizeOptionalString(values.resolution);
  const aspectRatio = normalizeOptionalString(values.aspectRatio) ?? normalizeOptionalString(values.aspect_ratio);
  if (size) parts.push(size);
  if (resolution && resolution.toLowerCase() !== size?.toLowerCase()) parts.push(resolution);
  if (aspectRatio) parts.push(aspectRatio);
  if (values.audio === true) parts.push('audio');
  if (values.audio === false) parts.push('no audio');
  return parts.length > 0 ? truncateText(parts.join(' · '), 140) : undefined;
}

function extractToolProgressCommand(event) {
  const params = normalizeEffectiveToolParams(event);
  const commandKey = commandParamKey(params);
  if (commandKey) {
    return summarizeProgressCommand(params[commandKey]);
  }
  const pathLike = extractProgressPathLike(params);
  if (pathLike) return pathLike;
  const query = normalizeOptionalString(params.query)
    ?? normalizeOptionalString(params.searchQuery)
    ?? normalizeOptionalString(params.search_query);
  if (query) return truncateText(redactProgressPreview(query), 160);
  const toolName = normalizeToolName(event);
  if (NATIVE_MEDIA_GENERATION_TOOLS.has(toolName) || toolName === 'image_edit') {
    return mediaProgressSummary(params, progressResultDetails(event));
  }
  return undefined;
}

function extractOpenAppName(command) {
  const byApp = command.match(/\bopen\s+-a\s+["']?([^"'\n]+)["']?/iu);
  if (byApp?.[1]) return byApp[1].trim();
  const byPath = command.match(/\bopen\s+((?:\/|~\/)[^\n]+)/u);
  if (!byPath?.[1]) return undefined;
  const normalized = byPath[1].trim();
  return normalized.split(/[\\/]/u).pop()?.replace(/\.app$/iu, '') || normalized;
}

function buildNativeToolCommentary(toolName, command) {
  const label = String(toolName ?? '').trim().toLowerCase();
  if (label === 'exec') {
    if (!command) return '我先继续执行当前步骤。';
    if (/\b(?:mdfind|find|lsregister|locate|rg|ls)\b/iu.test(command) && /(?:\/Applications\b|\.app\b|kMDItemContentType\s*={1,2}\s*["']?com\.apple\.application)/iu.test(command)) {
      return '我先在本机查找相关应用和快捷方式。';
    }
    if (/\bopen\b/iu.test(command)) {
      const appName = extractOpenAppName(command);
      return appName ? `我先尝试打开 ${appName}。` : '我先尝试启动相关应用。';
    }
    if (/\bosascript\b/iu.test(command) && /\b(?:keystroke|key\s+code|activate)\b/iu.test(command)) {
      return '我尝试继续执行应用里的下一步操作。';
    }
    if (/\b(?:pgrep|ps)\b/iu.test(command)) {
      return '我再确认应用是否仍在运行。';
    }
    if (/\b(?:cat|sed|awk|jq|plutil|defaults)\b/iu.test(command)) {
      return '我先查看相关信息。';
    }
    return undefined;
  }
  if (label === 'web_fetch' || label === 'browser') return '我先继续查看相关页面和内容。';
  if (label === 'read') return '我先查看相关内容。';
  if (label === 'edit' || label === 'apply_patch') return '我先修改相关内容。';
  return undefined;
}

function nativeToolProgressState(event, failed = false) {
  const details = progressResultDetails(event);
  const status = normalizeOptionalString(details.status)?.toLowerCase();
  if (status && /^(?:aborted|cancelled|canceled|stopped|terminated)$/u.test(status)) return 'aborted';
  if (status && /^(?:blocked|waiting_approval|approval_required|pending_approval)$/u.test(status)) return 'blocked';
  if (status && /^(?:partial|partially_completed|partial_failure)$/u.test(status)) return 'partial';
  if (failed) return 'error';
  if (details.async === true && status && ASYNC_PROGRESS_STARTED_STATUSES.has(status)) return 'submitted';
  return event?.result === undefined ? 'running' : 'completed';
}

function nativeToolProgressStatus(state) {
  if (state === 'error') return 'error';
  if (state === 'aborted') return 'aborted';
  if (state === 'blocked' || state === 'partial') return 'blocked';
  if (state === 'running' || state === 'submitted') return 'running';
  return 'completed';
}

function nativeToolProgressTranslationKey(state) {
  if (state === 'error') return 'runtimeProgress.toolFailed';
  if (state === 'blocked') return 'runtimeProgress.toolBlocked';
  if (state === 'aborted') return 'runtimeProgress.toolAborted';
  if (state === 'partial') return 'runtimeProgress.toolPartial';
  if (state === 'submitted') return 'runtimeProgress.toolSubmitted';
  if (state === 'running') return 'runtimeProgress.toolRunning';
  return 'runtimeProgress.toolCompleted';
}

function buildNativeToolActionText(toolLabel, state) {
  if (state === 'error') return `执行失败：${toolLabel}`;
  if (state === 'blocked') return `需要处理：${toolLabel}`;
  if (state === 'aborted') return `已停止：${toolLabel}`;
  if (state === 'partial') return `部分完成：${toolLabel}`;
  if (state === 'submitted') return `已提交：${toolLabel}`;
  if (state === 'running') return `正在执行：${toolLabel}`;
  return `已完成：${toolLabel}`;
}

function pruneProgressWrappers(now = Date.now()) {
  for (const [parentToolCallId, wrapper] of progressWrappersByParentToolCallId.entries()) {
    if (now - wrapper.updatedAt > PROGRESS_WRAPPER_TTL_MS) {
      progressWrappersByParentToolCallId.delete(parentToolCallId);
    }
  }
  while (progressWrappersByParentToolCallId.size > PROGRESS_WRAPPER_MAX_ENTRIES) {
    const oldestParentToolCallId = progressWrappersByParentToolCallId.keys().next().value;
    if (!oldestParentToolCallId) break;
    progressWrappersByParentToolCallId.delete(oldestParentToolCallId);
  }
}

function rememberStructuredProgressWrapper(event, ctx) {
  if (normalizeDirectToolName(event) !== 'tool_call') return;
  const parentToolCallId = normalizeOptionalString(event?.toolCallId) ?? normalizeOptionalString(event?.id);
  const targetToolName = normalizeToolName(event).trim().toLowerCase();
  if (!parentToolCallId || !targetToolName || targetToolName === 'tool_call') return;
  const now = Date.now();
  pruneProgressWrappers(now);
  progressWrappersByParentToolCallId.delete(parentToolCallId);
  progressWrappersByParentToolCallId.set(parentToolCallId, {
    runId: getRunId(event, ctx),
    targetToolName,
    updatedAt: now,
  });
}

function canonicalProgressToolCallId(event, ctx) {
  const toolCallId = normalizeOptionalString(event?.toolCallId) ?? normalizeOptionalString(event?.id);
  if (!toolCallId) return undefined;
  const nested = /^tool_search_code:(.+):([^:]+):\d+$/u.exec(toolCallId);
  if (!nested) return toolCallId;
  pruneProgressWrappers();
  const wrapper = progressWrappersByParentToolCallId.get(nested[1]);
  if (!wrapper) return toolCallId;
  const runId = getRunId(event, ctx);
  if (wrapper.runId && runId && wrapper.runId !== runId) return toolCallId;
  const childToolName = String(nested[2] ?? '').trim().toLowerCase();
  return childToolName === wrapper.targetToolName ? nested[1] : toolCallId;
}

function buildNativeToolProgressId(event, ctx, suffix = '') {
  const toolCallId = canonicalProgressToolCallId(event, ctx);
  const base = toolCallId
    ? `progress:tool:${toolCallId}`
    : `progress:tool:${hashString(normalizeToolName(event) || 'tool')}`;
  return suffix ? `${base}:${suffix}` : base;
}

function emitNativeToolProgress(api, event, ctx, entry) {
  const runEvent = {
    runId: getRunId(event, ctx),
    sessionKey: getSessionKey(event, ctx),
    cwd: event?.cwd ?? ctx?.cwd,
  };
  if (!getRunId(runEvent)) return;
  emitRuntimeEvent(api, runEvent, 'progress', {
    entry: {
      ...entry,
      text: redactProgressPreview(entry?.text),
      detail: typeof entry?.detail === 'string' ? redactProgressPreview(entry.detail) : entry?.detail,
      command: typeof entry?.command === 'string' ? redactProgressPreview(entry.command) : entry?.command,
      toolLabel: typeof entry?.toolLabel === 'string' ? redactProgressPreview(entry.toolLabel) : entry?.toolLabel,
      translationParams: entry?.translationParams && typeof entry.translationParams === 'object'
        ? {
            ...entry.translationParams,
            tool: typeof entry.translationParams.tool === 'string'
              ? redactProgressPreview(entry.translationParams.tool)
              : entry.translationParams.tool,
          }
        : entry?.translationParams,
      source: 'native',
      toolCallId: canonicalProgressToolCallId(event, ctx),
    },
  });
}

function emitToolCallProgress(api, event, ctx) {
  rememberStructuredProgressWrapper(event, ctx);
  const toolName = normalizeToolName(event);
  if (!toolName || HIDDEN_PROGRESS_TOOLS.has(toolName)) return;
  const command = extractToolProgressCommand(event);
  const commentary = buildNativeToolCommentary(toolName, command);
  if (commentary) {
    emitNativeToolProgress(api, event, ctx, {
      id: buildNativeToolProgressId(event, ctx, 'commentary'),
      kind: 'commentary',
      text: commentary,
      command,
      stepId: normalizeOptionalString(event?.toolCallId),
    });
  }
  const toolLabel = progressToolLabel(event, toolName);
  const state = nativeToolProgressState(event);
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx),
    kind: 'action',
    text: buildNativeToolActionText(toolLabel, state),
    status: nativeToolProgressStatus(state),
    translationKey: nativeToolProgressTranslationKey(state),
    translationParams: { tool: toolLabel },
    toolName,
    toolLabel,
    command,
    stepId: normalizeOptionalString(event?.toolCallId),
  });
}

function emitToolResultProgress(api, event, ctx) {
  rememberStructuredProgressWrapper(event, ctx);
  const toolName = normalizeToolName(event);
  if (!toolName || HIDDEN_PROGRESS_TOOLS.has(toolName)) return;
  const failed = isToolError(event);
  const toolLabel = progressToolLabel(event, toolName);
  const state = nativeToolProgressState(event, failed);
  const details = progressResultDetails(event);
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx),
    kind: 'action',
    text: buildNativeToolActionText(toolLabel, state),
    status: nativeToolProgressStatus(state),
    translationKey: nativeToolProgressTranslationKey(state),
    translationParams: { tool: toolLabel },
    toolName,
    toolLabel,
    command: extractToolProgressCommand(event),
    taskId: normalizeOptionalString(details.taskId) ?? normalizeOptionalString(details.task_id),
    stepId: normalizeOptionalString(event?.toolCallId),
  });
  if (!failed) return;
  const detail = summarizeToolFailure(event);
  if (!detail) return;
  emitNativeToolProgress(api, event, ctx, {
    id: buildNativeToolProgressId(event, ctx, 'status'),
    kind: 'status',
    text: detail,
    status: 'error',
    detail,
    stepId: normalizeOptionalString(event?.toolCallId),
  });
}

function emitToolResultRuntimeEvents(api, event, ctx) {
  const runEvent = buildMiddlewareRunEvent(event, ctx);
  if (!getRunId(runEvent)) return;

  emitToolResultProgress(api, event, ctx);
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
    recordToolEvidence(event, ctx);
    emitToolResultRuntimeEvents(api, event, ctx);
    const summarized = summarizeToolResultForTranscript(event);
    if (!summarized) return undefined;
    if (isRecord(event)) event.result = summarized.result;
    logDiagnostic('tool-result-transcript-compact', {
      eventId: eventId(event, ctx),
      toolName: summarized.meta.toolName,
      categories: summarized.meta.kinds,
      omittedChars: summarized.meta.charCount,
      omittedLines: summarized.meta.lineCount,
      hintCount: summarized.meta.hints.length,
      artifactRefCount: summarized.meta.artifactRefs.length,
    });
    return {
      result: summarized.result,
    };
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
    registerLifecycleHook(api, 'before_message_write', (event, ctx) => {
      const decision = sanitizeInternalTranscriptMessage(event?.message);
      if (decision.action === 'keep') return undefined;
      logDiagnostic(`internal-transcript-${decision.action}`, {
        eventId: eventId(event, ctx),
        role: event?.message?.role,
        reason: decision.reason,
      });
      if (decision.action === 'block') return { block: true };
      return { message: decision.message };
    }, {
      name: `${PLUGIN_ID}:internal-transcript-isolation`,
      description: 'Keep OpenClaw heartbeat, restart continuation, and runtime plumbing messages out of persisted transcripts.',
      priority: 1000,
    });
    registerLifecycleHook(api, 'before_prompt_build', async (event, ctx) => {
      const historySanitization = sanitizePromptHistoryMessages(event);
      if (historySanitization.blocked > 0 || historySanitization.rewritten > 0) {
        logDiagnostic('internal-prompt-history-sanitize', {
          eventId: eventId(event, ctx),
          ...historySanitization,
        });
      }
      const presentationCompaction = compactHistoricalPresentationToolCalls(event);
      if (presentationCompaction.compacted > 0) {
        logDiagnostic('presentation-prompt-history-compact', {
          eventId: eventId(event, ctx),
          ...presentationCompaction,
        });
      }
      const preferences = await requestTurnPreferencesFromHost(event, ctx);
      const promptContext = buildPromptContextForEvent(event, preferences);
      logDiagnostic('prompt-context', {
        eventId: eventId(event, ctx),
        injected: true,
        contextChars: promptContext.text.length,
        hasChineseRule: true,
        hasArtifactRule: promptContext.includeArtifactContext,
      });
      return {
        appendSystemContext: promptContext.text,
      };
    }, {
      name: PROMPT_CONTEXT_HOOK_ID,
      description: 'Inject UClaw artifact delivery, turn preferences, and Chinese language context before workspace context is ready.',
      timeoutMs: TURN_PREFERENCES_TIMEOUT_MS + 2_000,
    });
    registerLifecycleHook(api, 'before_tool_call', async (event, ctx) => {
      const screenshotRewrite = rewriteExecScreenshotParams(event);
      const effectiveEvent = screenshotRewrite
        ? {
            ...event,
            params: screenshotRewrite.params,
          }
        : event;
      if (screenshotRewrite) {
        logDiagnostic('exec-screenshot-path-rewrite', {
          eventId: eventId(event, ctx),
          toolName: screenshotRewrite.toolName,
          commandKey: screenshotRewrite.commandKey,
          rewrittenPaths: screenshotRewrite.rewrittenPaths,
        });
      }

      const toolName = normalizeToolName(effectiveEvent);
      const promptLengthBlock = nativeMediaPromptLengthBlock(effectiveEvent);
      if (promptLengthBlock) {
        logDiagnostic('native-media-prompt-too-long', {
          eventId: eventId(event, ctx),
          toolName: promptLengthBlock.toolName,
          characterCount: promptLengthBlock.characterCount,
          limit: NATIVE_MEDIA_PROMPT_MAX_CHARACTERS,
        });
        return {
          block: true,
          blockReason: promptLengthBlock.reason,
          reason: promptLengthBlock.reason,
        };
      }
      const undeclaredBlock = undeclaredSideEffectBlock(effectiveEvent, ctx);
      if (undeclaredBlock) {
        logDiagnostic('undeclared-side-effect-block', {
          eventId: eventId(event, ctx),
          toolName: undeclaredBlock.toolName,
        });
        return {
          block: true,
          blockReason: undeclaredBlock.reason,
          reason: undeclaredBlock.reason,
        };
      }
      const sideEffectMismatchBlock = contractSideEffectMismatchBlock(effectiveEvent, ctx);
      if (sideEffectMismatchBlock) {
        logDiagnostic('side-effect-contract-mismatch', {
          eventId: eventId(event, ctx),
          toolName: sideEffectMismatchBlock.toolName,
          declaredSideEffect: sideEffectMismatchBlock.declaredSideEffect,
          actualSideEffect: sideEffectMismatchBlock.actualSideEffect,
        });
        return {
          block: true,
          blockReason: sideEffectMismatchBlock.reason,
          reason: sideEffectMismatchBlock.reason,
        };
      }
      const authorizationBlock = unauthorizedSideEffectBlock(effectiveEvent, ctx);
      if (authorizationBlock) {
        logDiagnostic('side-effect-authorization-block', {
          eventId: eventId(event, ctx),
          toolName: authorizationBlock.toolName,
          sideEffect: authorizationBlock.sideEffect,
        });
        return {
          block: true,
          blockReason: authorizationBlock.reason,
          reason: authorizationBlock.reason,
        };
      }
      if (toolName && MEDIA_SIDE_EFFECT_TOOLS.has(toolName)) {
        logDiagnostic('native-media-tool-call', {
          eventId: eventId(event, ctx),
          toolName,
          authorization: 'native_agent_tool_selection',
        });
      }

      const staging = await stageMediaToolInputs(effectiveEvent, ctx);
      if (staging.blockReason) {
        logDiagnostic('media-input-staging-failed', {
          eventId: eventId(event, ctx),
          toolName,
          errorCode: staging.errorCode,
        });
        return {
          block: true,
          blockReason: staging.blockReason,
          reason: staging.blockReason,
        };
      }
      if (staging.stagedCount > 0) {
        effectiveEvent.params = staging.params;
        logDiagnostic('media-input-staged', {
          eventId: eventId(event, ctx),
          toolName,
          stagedCount: staging.stagedCount,
          stagedParamKeys: staging.stagedParamKeys,
        });
      }

      emitToolCallProgress(api, effectiveEvent, ctx);
      if (screenshotRewrite || staging.stagedCount > 0) {
        return {
          params: effectiveEvent.params,
        };
      }
      return undefined;
    }, {
      name: MEDIA_TOOL_PREPARATION_HOOK_ID,
      description: 'Stage media inputs, rewrite managed screenshot paths, and project native media tool progress.',
      priority: 100,
    });
    registerLifecycleHook(api, 'before_agent_finalize', (event, ctx) => {
      const analysis = analyzeArtifactFinal(event, ctx);
      logDiagnostic('finalize-check', {
        eventId: eventId(event, ctx),
        userTextChars: analysis.userText.length,
        finalTextChars: analysis.finalText.length,
        emptyFinal: analysis.emptyFinal,
        heartbeatPoll: analysis.heartbeatPoll,
        heartbeatOk: analysis.heartbeatOk,
        artifactRequest: analysis.artifactRequest,
        contractDeclared: Boolean(analysis.declaredContract),
        contractIntent: analysis.declaredContract?.intent,
        legacySemanticFallback: analysis.legacySemanticFallback,
        artifactRevisionFeedback: analysis.artifactRevisionFeedback,
        artifactRevisionRequest: analysis.artifactRevisionRequest,
        artifactContinuationPromise: analysis.artifactContinuationPromise,
        completionArtifactKind: analysis.completionArtifactKind,
        textLengthRequirement: analysis.textLengthRequirement,
        enforceCurrentRunToolEvidence: analysis.enforceCurrentRunToolEvidence,
        currentRunToolAttemptCount: analysis.currentRunToolAttemptCount,
        currentRunFailedToolCount: analysis.currentRunFailedToolCount,
        currentRunSuccessfulArtifactCount: analysis.currentRunSuccessfulArtifactCount,
        priorArtifactEvidence: analysis.priorArtifactEvidence,
        priorArtifactCount: analysis.priorArtifactCount,
        compositeRequiredArtifactCount: analysis.compositeRequiredArtifactCount,
        rawCompositeRequiredArtifactCount: analysis.rawCompositeRequiredArtifactCount,
        requiredEffectCount: analysis.requiredEffects.length,
        missingRequiredEffectCount: analysis.missingRequiredEffects.length,
        requiredEffectTypes: analysis.requiredEffects.map((effect) => effect.type),
        requiredEffectKinds: analysis.requiredEffects.map((effect) => effect.kind),
        missingRequiredEffectKinds: analysis.missingRequiredEffects.map((result) => result.effect.kind),
        missingRequiredEffectReasons: analysis.missingRequiredEffects.map((result) => result.reason),
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
        approvalRequired: analysis.approvalRequired,
        authorizationMissing: analysis.authorizationMissing,
        shouldReviseHeartbeat: analysis.shouldReviseHeartbeat,
        shouldReviseEmptyFinal: analysis.shouldReviseEmptyFinal,
        shouldReviseAuthorization: analysis.shouldReviseAuthorization,
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
  version: '0.1.19',
  register(api) {
    registerArtifactGuard(api);
  },
};

export const __test = {
  shouldReviseArtifactFinal,
  analyzeArtifactFinal,
  isArtifactCapabilityQuestion,
  isArtifactRequest,
  requestedTextLength,
  countTextContentUnits,
  deriveRequiredEffects,
  evaluateRequiredEffects,
  buildRevision,
  buildArtifactEvidence,
  unauthorizedSideEffectBlock,
  undeclaredSideEffectBlock,
  contractSideEffectMismatchBlock,
  knownToolSideEffect,
  nativeMediaPromptLengthBlock,
  buildToolArtifactEvidence,
  summarizeToolResultForTranscript,
  emitToolCallProgress,
  emitToolResultProgress,
  emitToolResultRuntimeEvents,
  emitRuntimeEvent,
  canonicalProgressToolCallId,
  rememberStructuredProgressWrapper,
  rewriteTmpScreenshotMediaPaths,
  rewriteExecScreenshotParams,
  stageMediaToolInputs,
  recordToolEvidence,
  getToolEvidenceForRun,
  isInternalTranscriptMessage,
  classifyInternalTranscriptMessage,
  sanitizeInternalTranscriptMessage,
  sanitizePromptHistoryMessages,
  compactHistoricalPresentationToolCalls,
  PROMPT_CONTEXT,
};
