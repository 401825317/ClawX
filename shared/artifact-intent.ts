const ARTIFACT_CAPABILITY_TARGET_RE = /(?:文件(?:类)?产物|文件|文档|报告|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|(?:张|幅)?图|海报|视频|网页|HTML|html|小程序|代码文件|压缩包|zip|产物|artifact|file|document|report|presentation|slides?|spreadsheet|image|video|webpage|mini[-\s]?app)/iu;
const ARTIFACT_CAPABILITY_QUESTION_RE = /(?:能做哪些|可以做哪些|支持哪些|支持生成哪些|能生成哪些|能创建哪些|能产出哪些|可以生成哪些|可以创建哪些|能(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|可以(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|支持(?:什么|哪些|哪类|哪种)|有哪些(?:能力|功能|文件|产物|类型|格式)|有什么(?:能力|功能)|能力(?:范围|列表|介绍)|(?:能|可以)做吗|能不能做|支不支持|what can you|which .{0,40} can|can you|support(?:ed)?|capabilit)/iu;
const ARTIFACT_DIRECT_CAPABILITY_QUESTION_RE = /(?:你)?(?:能|可以|会|支持|能不能|可不可以).{0,24}(?:做|制作|生成|创建|导出|输出|出图|生图|生视频).{0,24}(?:(?:吗|么|不|不行|是否|能否)[?？]?|[?？])$/iu;
const ARTIFACT_IMMEDIATE_REQUEST_RE = /(?:帮我|给我|替我|请(?:你)?|直接|现在就|马上|立即)/iu;
const ARTIFACT_FUTURE_PREFERENCE_RE = /(?:以后|今后|下次|往后|记住|保存(?:这个)?偏好|设为默认)/iu;
const ARTIFACT_CREATE_COMMAND_RE = /(?:(?:帮我|给我|替我|直接).{0,20}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出)|(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|(?:生|出)(?:一?张|一个|一段|些|点)?(?:图|图片|视频)|(?:每个|各个|每种|每类).{0,16}来(?:一个|一份|一张|一套|一段)|(?:create|make|generate|build|produce|export|write)\s+(?:a|an|one|some|the)\b)/iu;
const ARTIFACT_MUTATION_COMMAND_RE = /(?:修图|改图|编辑|修改|美化|重做|改(?:一下|一版)?|edit|modify|revise|retouch)/iu;
const ARTIFACT_NEGATED_ACTION_RE = /(?:(?:不要|别|无需|不需要|不用|禁止|只读|仅只读).{0,24}(?:做|制作|生成|创建|导出|输出|保存|写|编写|起草|修改|编辑|改动|产出)|(?:只|仅)(?:做)?(?:分析|解释|诊断|查看|检查|评估|讨论).{0,24}(?:不要|不|无须|无需)?.{0,12}(?:写|改|生成|创建|保存|输出|导出)|(?:do\s+not|don't|without|read[-\s]?only).{0,24}(?:create|make|generate|write|modify|edit|save|export))/iu;

export function isArtifactCapabilityQuestion(text: string | null | undefined): boolean {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  if (
    ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && ARTIFACT_DIRECT_CAPABILITY_QUESTION_RE.test(value)
    && !ARTIFACT_IMMEDIATE_REQUEST_RE.test(value)
  ) {
    return true;
  }
  return ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && ARTIFACT_CAPABILITY_QUESTION_RE.test(value)
    && !ARTIFACT_CREATE_COMMAND_RE.test(value);
}

export function isArtifactCreationRequest(text: string | null | undefined): boolean {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value || isArtifactCapabilityQuestion(value)) return false;
  if (ARTIFACT_FUTURE_PREFERENCE_RE.test(value) && !ARTIFACT_IMMEDIATE_REQUEST_RE.test(value)) return false;
  if (ARTIFACT_NEGATED_ACTION_RE.test(value)) return false;
  return ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && (ARTIFACT_CREATE_COMMAND_RE.test(value) || ARTIFACT_MUTATION_COMMAND_RE.test(value));
}
