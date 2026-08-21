// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const skillPath = 'resources/openclaw-skill-shims/ecommerce-main-image/SKILL.md';
const activePluginSkillPath = 'resources/openclaw-plugins/uclaw-local-artifacts/skills/ecommerce-main-image/SKILL.md';

function readSkill(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('ecommerce main image skill contract', () => {
  it('keeps the shim and runtime plugin skill byte-for-byte aligned', () => {
    expect(readSkill(activePluginSkillPath)).toBe(readSkill(skillPath));
  });

  it('uses a versioned image-mode preset contract and recognizes natural-language requests', () => {
    const skill = readSkill(skillPath);

    expect(skill).toContain('name: ecommerce-main-image');
    expect(skill).toContain('"skillVersion": "v1"');
    expect(skill).toContain('`ecommerce-main-image`');
    expect(skill).toContain('“电商主图”');
    expect(skill).toContain('“商品主图”');
    expect(skill).toContain('“白底主图”');
    expect(skill).toContain('“商品场景图”');
    expect(skill).toContain('“商品卖点图”');
    expect(skill).toContain('“ecommerce main image”');
    expect(skill).toContain('“product hero image”');
  });

  it('separates white-background, scene, and selling-point composition without inventing claims', () => {
    const skill = readSkill(skillPath);

    expect(skill).toContain('白底主图：商品主体完整');
    expect(skill).toContain('场景图：场景必须服务于商品用途和目标人群');
    expect(skill).toContain('卖点图：只表达用户提供或参考图中能够确认的卖点');
    expect(skill).toContain('不虚构规格、认证、价格、功效或活动信息');
  });

  it('treats reference-image product facts as immutable unless the user explicitly requests a new design', () => {
    const skill = readSkill(skillPath);

    expect(skill).toContain('商品结构、比例、包装形态、Logo、商标、原有文字、颜色、材质、接口、配件数量和包装信息');
    expect(skill).toContain('不可擅自重绘的商品事实');
    expect(skill).toContain('无法辨认的文字不得猜测、补全或重写');
    expect(skill).toContain('任何与参考图冲突的生成结果必须视为失败');
    expect(skill).toContain('没有明确确认，不得自行作此转换');
  });

  it('delegates model, size, and quality exclusively to runtime capabilities and fails closed when absent', () => {
    const skill = readSkill(skillPath);

    expect(skill).toContain('只消费当前 UClaw 运行时或图片工具返回的能力与默认值');
    expect(skill).toContain('不指定模型 ID、固定像素、固定比例或质量等级');
    expect(skill).toContain('当前没有可用的图片生成能力');
    expect(skill).toContain('不得猜测或伪造请求参数');
    expect(skill).not.toMatch(/\b(?:gpt-image|dall-e|flux|midjourney)\b/iu);
    expect(skill).not.toMatch(/\b(?:1024|768|720|512)\s*[x*]\s*(?:1024|768|720|512)\b/iu);
  });
});
