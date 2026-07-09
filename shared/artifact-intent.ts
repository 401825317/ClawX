const ARTIFACT_CAPABILITY_TARGET_RE = /(?:文件(?:类)?产物|文件|文档|报告|PPT|pptx?|演示文稿|幻灯片|Word|docx?|Excel|xlsx?|表格|PDF|pdf|图片|图像|海报|视频|网页|HTML|html|小程序|代码文件|压缩包|zip|产物|artifact|file|document|report|presentation|slides?|spreadsheet|image|video|webpage|mini[-\s]?app)/iu;
const ARTIFACT_CAPABILITY_QUESTION_RE = /(?:能做哪些|可以做哪些|支持哪些|支持生成哪些|能生成哪些|能创建哪些|能产出哪些|可以生成哪些|可以创建哪些|能(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|可以(?:做|生成|创建|产出|导出|输出|制作)(?:什么|哪些|哪类|哪种)|支持(?:什么|哪些|哪类|哪种)|有哪些(?:能力|功能|文件|产物|类型|格式)|有什么(?:能力|功能)|能力(?:范围|列表|介绍)|(?:能|可以)做吗|能不能做|支不支持|what can you|which .{0,40} can|can you|support(?:ed)?|capabilit)/iu;
const ARTIFACT_CREATE_COMMAND_RE = /(?:(?:帮我|给我|替我|直接).{0,20}(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出)|(?:做|制作|生成|创建|导出|输出|写|编写|起草|弄|出).{0,8}(?:一个|一份|一张|一套|个|份|张|套)|(?:create|make|generate|build|produce|export|write)\s+(?:a|an|one|some|the)\b)/iu;

export function isArtifactCapabilityQuestion(text: string | null | undefined): boolean {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return false;
  return ARTIFACT_CAPABILITY_TARGET_RE.test(value)
    && ARTIFACT_CAPABILITY_QUESTION_RE.test(value)
    && !ARTIFACT_CREATE_COMMAND_RE.test(value);
}
