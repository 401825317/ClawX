---
id: uclaw-codex-experience-benchmark
title: UClaw vs Codex desktop experience benchmark
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Use one shared prompt suite to compare Codex desktop and UClaw across routing, execution autonomy, artifact quality, progress display, history recovery, concurrency, and performance, then turn observed gaps into implementation work.
touchedAreas:
  - harness/specs/tasks/uclaw-codex-experience-benchmark.md
  - src/stores/chat.ts
  - src/stores/chat/runtime-contract.ts
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatMessage.tsx
  - electron/utils/media-intent-planner.ts
  - electron/utils/media-generation-jobs.ts
  - electron/utils/local-artifact-planner.ts
  - electron/utils/local-artifact-runtime.ts
  - electron/api/routes/media.ts
  - resources/openclaw-plugins/uclaw-local-artifacts/index.mjs
  - resources/openclaw-plugins/uclaw-local-artifacts/package.json
  - resources/openclaw-plugins/uclaw-local-artifacts/openclaw.plugin.json
  - resources/openclaw-skill-shims/presentation-maker/SKILL.md
  - resources/openclaw-skill-shims/presentation-maker/scripts/make-pptx.mjs
expectedUserBehavior:
  - Same prompt can be run in Codex desktop and UClaw with comparable evidence.
  - UClaw should not expose internal routing limitations, raw execution graph details, or mode conflicts to normal users.
  - UClaw should produce durable artifacts, visible progress, recoverable history, and useful final summaries for multi-step work.
  - PPT, Excel, and mini-program outputs should be agent/skill-grade artifacts, not thin fixed templates.
requiredProfiles:
  - fast
  - comms
  - product
  - media
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - comms-regression
  - presentation-artifact-quality
acceptance:
  - Prompt suite covers ordinary chat, preference/memory, image, image edit, video, composite multi-deliverable work, PPT, Excel, mini-program/web app, history recovery, concurrency, failure recovery, performance, and process display.
  - Each prompt declares priority, exact text, Codex expected visible behavior, and UClaw observation focus.
  - PPT, Excel, and mini-program/web app prompts include a quality bar that rejects fixed-template-only artifacts.
  - PPT evidence records the selected semantic theme family, visible page-frame diversity, layout kinds, and cross-topic theme signatures.
  - Result log template records Codex actual behavior, UClaw actual behavior, scores, gap classification, required implementation, and evidence.
docs:
  required: false
---

## Purpose

This benchmark prevents subjective "feels like Codex" arguments from drifting.
For each prompt below, run the exact same text in:

1. Codex desktop.
2. UClaw current feature branch.

Record observable behavior only. Do not claim Codex internal architecture unless verified by source.

## Evidence To Collect Per Prompt

- Prompt text.
- Fresh session or follow-up session marker.
- Run kind:
  - `observed`: both sides were actually run or manually observed.
  - `codex-baseline`: Codex side is an external visible-behavior baseline inferred from current Codex desktop behavior, not an internal implementation claim.
  - `uclaw-code-evidence`: UClaw side is based on source/runtime evidence and still needs manual UI confirmation.
- Codex visible behavior:
  - intent understanding
  - whether it asks a question
  - progress style
  - artifacts produced
  - final response shape
  - elapsed time
- UClaw visible behavior:
  - route/mode chosen
  - visible progress text or graph
  - artifacts produced
  - final response shape
  - elapsed time
  - whether history survives app restart
- Evidence:
  - screenshots when UI behavior matters
  - artifact paths or filenames
  - video playback duration if video involved
  - transcript reload result after restart when required

## Scoring

Use 0 / 1 / 2 for each dimension.

- Intent: understands the user's real goal without exposing internal mode conflict.
- Autonomy: picks sane defaults and continues instead of asking unnecessary questions.
- Artifact: produces the required durable artifacts.
- Quality: output is genuinely useful, not just placeholder/template content.
- Progress: process display is calm, compact, and user-facing.
- History: reload/restart preserves user-visible result and context.
- Performance: latency is explainable and not padded by local orchestration.
- Recovery: missing input, provider failure, or partial failure produces a useful path forward.

## Global Pass Bar

UClaw is not release-ready if any P0 prompt:

- ends with "I can only do one task, choose one";
- produces no artifact for an artifact request;
- shows only raw internal graph/tool/gate text to normal users;
- loses completed artifacts after refresh/restart;
- mixes another user turn into the wrong task panel;
- returns a broken video, expired media link, or 0-second playable output;
- creates PPT/Excel/mini-program artifacts that are only fixed templates when the prompt asks for meaningful work.

## Execution Protocol

Run prompts in batches. For each batch:

1. Run the exact same prompt text in Codex desktop and UClaw.
2. Record only visible behavior and concrete evidence.
3. Mark whether the row is `observed`, `codex-baseline`, or `uclaw-code-evidence`.
4. Convert every P0/P1 gap into one implementation item with a code owner area.
5. Re-run the same prompt after implementation and keep the before/after rows.

Do not turn Codex behavior into a claimed internal architecture unless the source is actually verified.

## Prompt Suite

### A. Plain Chat, Preference, And Memory

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| A01 | P0 | `以后生成作品的时候，如果需要图片就从网上获取，保存在记忆体里` | Treat as preference/memory update. No execution graph needed. Short confirmation. | Does UClaw route to ordinary chat/memory, or does it show execution graph/0ms process? |
| A02 | P0 | `你记住，我以后默认喜欢中文结果，文件名也用中文` | Store preference or confirm scope. | Does history/follow-up honor it? |
| A03 | P1 | `我刚才说的默认图片素材来源是什么？` | Answer from prior preference. | Does reset/family transcript preserve memory? |
| A04 | P1 | `帮我解释一下这个错误是什么意思：TypeError: Cannot read properties of undefined` | Answer directly, no tool unless needed. | Does UClaw over-route to execution mode? |
| A05 | P1 | `给我 3 个适合做 AI 产品周报的标题` | Produce 3 titles. | No artifact or graph should appear. |
| A06 | P2 | `你觉得这个方案哪里最冒险？` | Reasoned critique. | Does UClaw ask unnecessary clarifying questions? |

### B. Image, Vision, Edit, And Video Routing

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| B01 | P0 | `随便给我生成一张图片` | Generate one image with sane default subject/params. | Total time, progress wording, image visible immediately, history reload. |
| B02 | P0 | `生成一张 16:9 的未来城市工作台海报，尽量高清` | Generate image with inferred size/quality. | Does planner choose max allowed sensible params? |
| B03 | P0 | `把这张图改成暖色电影感` with one image attached | Edit attached image. | Uses explicit image, does not generate unrelated new image. |
| B04 | P0 | `把刚才那张图做成视频` after B01 | Use prior generated image as source if available. | Family transcript/source image lookup. |
| B05 | P0 | `随便生成一个 15 秒视频` | Generate video, final playable with duration > 0. | Video link/file durability, playback, time breakdown. |
| B06 | P1 | `生成一张图，然后基于这张图生成一个视频` | Two-step image then image-to-video. | Artifact dependency and progress. |
| B07 | P1 | `这张图好看吗？哪里可以优化？` with image attached | Vision critique, no edit unless asked. | Avoid image_edit route. |
| B08 | P1 | `把这个 logo 放到图片右下角` with two images attached | Image edit with multiple sources, maybe ask if ambiguous. | Correct reference handling. |
| B09 | P1 | `给我 3 张不同风格的封面图` | Either generate 3 or clearly batch them. | Image queue/concurrency, per-image delivery. |
| B10 | P2 | `生成一个竖屏短视频，适合朋友圈` | Choose portrait video params if supported. | Param selection and final display. |
| B11 | P0 | After generating an image: `根据生成的图片制作一个 15 秒视频` | Use the generated image selected by the current-turn planner. | Must remain image-to-video; no normalization downgrade to text-to-video. |

### C. Composite Multi-Deliverable Work

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| C01 | P0 | `生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个` | Build a sample pack with defaults. Do not ask user to choose one. Final shows artifact manifest. | 7 logical deliverables, no internal mode conflict, history reload intact. |
| C02 | P0 | `给我做一套“咖啡店开业”的素材包：海报、菜单表格、开业宣传文案、小程序页面、短视频脚本` | Produce all deliverables that do not require external media. | Composite task queue, artifact naming, final manifest. |
| C03 | P0 | `我明天要汇报 AI 降本增效，帮我一次性准备 PPT、预算 Excel、演讲稿和一张封面图` | Create four useful artifacts. | PPT/Excel quality and image integration. |
| C04 | P1 | `给我做一个产品发布会资料包，主题你定，包括 PPT、邀请函文案、流程表和页面 Demo` | Choose theme and deliver artifacts. | Autonomy and artifact quality. |
| C05 | P1 | `随便做一个儿童节活动方案，包含海报、排期表、预算表、小程序报名页` | Structured artifacts, useful defaults. | Excel formulas and mini-program usability. |
| C06 | P1 | `帮我做一个销售周报包：Excel 数据表、可视化图表、PPT 汇报、总结文案` | Generate cohesive report pack. | Cross-artifact consistency. |
| C07 | P1 | `做一个旅行计划包：行程表、预算表、路线页面、宣传图` | Produce multi-format travel pack. | File types, manifest, no unnecessary questions. |
| C08 | P2 | `做一套社媒素材，图片 3 张，短文案 5 条，视频 1 个` | Batch media plus copy. | Queue progress, partial delivery. |

### D. PPT Quality: Template-Level vs Agent/Skill-Level

PPT must be judged by content structure, visual hierarchy, page count, readable Chinese, and file validity.

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| D01 | P0 | `做一个 8 页 PPT：《AI 工作流如何提升团队效率》，要有目录、痛点、方案、案例、ROI、落地计划` | Real 8-page deck, each page has meaningful content and layout. | Not a fixed 5-page template. Validate pptx opens. |
| D02 | P0 | `把这个主题做成适合老板看的汇报 PPT：为什么我们要投入 UClaw 执行层产品化` | Executive tone, decision-oriented structure. | Business framing, not generic AI workflow text. |
| D03 | P1 | `做一个销售培训 PPT，主题是“如何跟进企业客户”，要有练习题` | Includes training structure and exercises. | Content specificity. |
| D04 | P1 | `做一个发布会风格 PPT，主题是“个人 AI 工作台”，页面要高级一点` | Product-launch theme with stage-style cover, high-impact statement pages, coherent hierarchy, and no text overflow. | Semantic `product-launch` selection and visible structure, not random recoloring. |
| D05 | P1 | `根据下面要点做 PPT：目标用户、小红书投放、转化路径、预算、风险` | Uses provided outline faithfully. | Does it preserve user input, not replace with template. |
| D06 | P2 | `生成 PPT 后帮我检查每页标题是否重复、是否有空页` | Create and verify. | Verification output tied to actual deck. |
| D07 | P0 | `生成一个苹果18的宣传介绍 PPT` | Plan and produce an Apple 18-specific product-launch deck. | `product-launch` theme signature, stage cover/page frame, subject-specific content, and no generic fixed-template fast path. |
| D08 | P0 | `生成一个张家界旅游介绍 PPT` after D07 in a fresh run | Plan and produce a Zhangjiajie-specific travel-editorial deck. | `travel-editorial` theme signature and page frame differ materially from D07, not only content or accent color. |

### E. Excel Quality: Data, Formulas, Formatting, Validation

Excel must be judged by formulas, sheet structure, formatting, and file validity.

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| E01 | P0 | `做一个月度预算 Excel，包含预算、实际、差额、完成率、合计和图表` | Real xlsx with formulas and chart/formatting if feasible. | Not a static table only. Validate formulas. |
| E02 | P0 | `做一个销售漏斗 Excel：线索、商机、成交、转化率、预计收入` | Multiple metrics with formulas. | Formula correctness and meaningful sample data. |
| E03 | P1 | `做一个项目排期 Excel，有任务、负责人、开始结束日期、进度、风险等级` | Useful tracking sheet, styles, validation if possible. | Usability beyond template. |
| E04 | P1 | `做一个客户续费预测表，给 20 条模拟客户数据和续费概率` | Generates data and calculated risk bands. | Data richness and calculations. |
| E05 | P1 | `做完 Excel 后告诉我哪些单元格用了公式` | Answer from actual workbook. | Verification reads or records formula locations. |
| E06 | P2 | `把预算表做成两个 sheet：明细和汇总` | Multi-sheet workbook. | Sheet count and cross-sheet formulas. |

### F. Mini-Program / Web App Quality

Mini-program can be HTML prototype or actual mini-program depending current product scope, but it must be runnable and interactive.

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| F01 | P0 | `做一个可运行的 Todo 小程序，有新增、完成、删除、筛选` | Runnable app with real interactions. | Not static HTML. Open locally and test. |
| F02 | P0 | `做一个灵感收集小工具，支持标签、搜索、本地保存` | Interactive app, local persistence if feasible. | JS behavior and localStorage. |
| F03 | P1 | `做一个活动报名页面，包含表单校验和报名成功状态` | Form validation and state. | UX states and error handling. |
| F04 | P1 | `做一个咖啡店菜单小程序，可以按分类筛选并计算购物车总价` | Interactive menu/cart. | Cart logic and UI density. |
| F05 | P1 | `做一个销售线索 Kanban，小卡片可以拖动或至少切换状态` | Kanban interaction. | Does generated app actually work? |
| F06 | P2 | `做完后自己检查一下页面有没有明显重叠或按钮没反应` | Visual/interaction verification. | Playwright/manual verification evidence. |
| F07 | P0 | `做一个奶茶点单小程序` | Runnable drink menu with categories, cart, quantity, and total. | Must not fall back to an unrelated Todo template. |

### G. History, Follow-Up, And Context Recovery

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| G01 | P0 | Run C01, close UClaw, reopen same session | Full artifact manifest and final reply remain. | No "only video" regression. |
| G02 | P0 | After B01: `你觉得这张图美嘛？` | Understands previous image. | Family transcript image lookup. |
| G03 | P0 | After C01 restart: `把刚才那个 PPT 再优化成老板汇报版` | Finds prior PPT artifact and edits/creates revision. | Artifact manifest lookup, not lost context. |
| G04 | P1 | After E01: `把预算里的餐饮预算提高 20%` | Updates workbook or creates revised copy. | Revision flow. |
| G05 | P1 | After F01: `给这个小程序加一个深色模式` | Modifies app artifact. | Prior file lookup and edit. |
| G06 | P1 | Reset session then ask about prior media | Should only recover intended family context if product says so. | Reset/family transcript policy. |
| G07 | P2 | Delete conversation and check sidebar/token history | Deleted conversation should disappear consistently. | Cleanup consistency. |
| G08 | P0 | After F07 has generated but delivery is pending/failed: `东西呢？` | Resume or retry the structured artifact delivery contract. | Uses run/manifest state, not phrase matching or ordinary-chat fallback. |

### H. Concurrency And Multi-Run Isolation

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| H01 | P0 | Send `生成一张猫图`; immediately send `生成一张狗图` | Two runs remain separate. | Second instruction must not jump into first task panel. |
| H02 | P0 | Start video generation; immediately ask ordinary chat question | Chat question should not be swallowed. | Run isolation and input availability. |
| H03 | P0 | Start C01; while running ask `再给我写 3 条朋友圈文案` | Queued or separate run, clearly attributed. | No context contamination. |
| H04 | P1 | Generate 5 images in one request | Queue/concurrency visible but compact. | Max 5 behavior, no slowdown surprises. |
| H05 | P1 | Generate 2 videos in one request | Queue or clear sequencing. | Provider limits and progress. |
| H06 | P1 | Two separate sessions running tasks | Session switch must not mix history or graph. | Session-scoped run state. |

### I. Missing Input, Failure, And Recovery

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| I01 | P0 | `根据图片修图，随便修一下` with no prior/attached image | Ask for image or use generated fallback only if task includes generation. | No fake edit, no blocked internal gate text. |
| I02 | P0 | `帮我打开微信并给某群发消息` | If capability unavailable, explain safe limitation and alternatives. | Must not rely on removed/disabled broken plugin. |
| I03 | P0 | Force image provider failure | Partial failure should produce retry/clear error. | No stuck "进行中". |
| I04 | P0 | Force video provider returns invalid/0s output | Detect and mark failed, retry or report. | Playback validation. |
| I05 | P1 | Ask for PPT with impossible source file | Ask for missing file while continuing possible parts. | Partial progress. |
| I06 | P1 | Network disconnect during long task | Resume or recover from transcript. | No duplicate/ghost runs. |

### J. Performance And Timing

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| J01 | P0 | `随便生成一个图片` | Timing roughly equals provider + small overhead. | planner, queue, provider, save, history, render timings. |
| J02 | P0 | `随便生成一个视频` | Clear long-running progress. | Provider vs local overhead, playable output. |
| J03 | P1 | C01 composite prompt | Partial deliverables should appear as they finish. | Does video block whole final delivery? |
| J04 | P1 | `做一个 PPT` | No unnecessary media planner/model calls. | Route latency. |
| J05 | P1 | Ordinary chat memory prompt A01 | Near-chat latency, no graph overhead. | Internal execution overhead. |

### K. Process Display And UI Cleanliness

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| K01 | P0 | Any ordinary chat prompt | No execution graph shown. | Avoid "Main Agent 执行 / Gate / 0ms". |
| K02 | P0 | B01 image generation | One compact progress line, final image. | No raw branch/gate spam. |
| K03 | P0 | C01 composite prompt | Compact progress plus final manifest. | Not a messy interleaving of cards. |
| K04 | P1 | Failed artifact task | Friendly failure summary. | Hide internal codes by default. |
| K05 | P1 | Developer mode enabled | Details available when intentionally expanded. | Raw graph remains useful for debugging. |

### L. Mode Hint Should Not Trigger Side Effects

These prompts catch the difference between a UI mode hint and the user's actual intent.

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| L01 | P0 | `先别生成图片，帮我写 3 条适合生图的提示词` | Return three prompts only. No image. | No image queue or artifact should start. |
| L02 | P0 | In image mode: `解释一下图片模式和普通聊天有什么区别` | Explain. No image. | Image mode remains a hint, not forced side effect. |
| L03 | P0 | In video mode: `我现在不生成视频，只想知道默认视频参数是什么` | Explain current/default parameters. No video. | Video mode remains a hint; no `video_generate`. |
| L04 | P0 | `以后我说做海报时，默认先找参考图，但这次别生成` | Treat as preference/memory update. | Short confirmation; no search/image generation. |
| L05 | P1 | In image mode: `图片模式里帮我写一段朋友圈文案` | Write copy. | Text response only. |

### M. Media Dependency, Batch Count, And Validity

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| M01 | P0 | `生成一张图，然后把这张图改成赛博朋克风，再基于改后的图生成 15 秒视频` | Produce image, edited image, then video using the edited image. | Dependency chain must use the edited image, not text-to-video fallback. |
| M02 | P0 | After an image: `把刚才那张图做成视频，不要重新生成新图` | Use the prior image and produce playable video. | History image lookup and duration > 0. |
| M03 | P1 | `给我 6 张不同风格的产品封面图` | Generate six or clearly explain batch limit. | Do not silently produce only one. |
| M04 | P1 | `给我 5 个短视频，每个 15 秒，主题不同` | Queue or batch clearly, final per-item status. | Video queue/run ownership and provider limits. |
| M05 | P0 | `生成一个 0 秒视频` | Reject/clarify invalid duration. | Broken 0-second video must not be marked success. |
| M06 | P1 | `生成竖屏 9:16 视频，适合朋友圈，最长时长` | Choose portrait and max supported duration. | Parameter selection. |

### N. Source-Driven Office And Web Artifacts

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| N01 | P0 | `根据下面材料做 8 页老板汇报 PPT：目标、现状、成本、方案、风险、里程碑、ROI、决策点……` | Real deck derived from source material. | Eight pages, non-duplicate titles, content uses material. |
| N02 | P0 | `做一个 Excel：20 条模拟销售数据，含线索、商机、成交率、客单价、预计收入；生成后列出公式单元格` | Real workbook with formulas and formula evidence. | Formula cells are recorded from the actual file. |
| N03 | P0 | `做一个活动报名小程序：表单校验、报名成功状态、报名列表、本地保存、移动端不重叠` | Runnable interactive app. | Validation, success state, list, persistence, responsive layout. |
| N04 | P1 | `把这段乱糟糟的需求整理成 PPT + Excel 排期 + 小程序 Demo，三者字段要一致` | Cross-artifact consistency. | Shared fields/theme across artifacts. |
| N05 | P1 | `生成完 PPT 后，告诉我每页标题，并检查有没有空页` | Verify from the generated file. | No invented verification. |

### O. Progressive Composite Delivery And Manifest

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| O01 | P0 | `做一套咖啡店开业包：海报、PPT、菜单 Excel、报名小程序、短视频、3 条文案；视频排最后，其他先交` | Progressively deliver non-video artifacts, then video. | Video must not block all other visible results. |
| O02 | P0 | `做资料包，其中缺 logo 的就先跳过并标记待补，其他继续` | Partial progress with skipped item. | Missing input blocks only relevant subtask. |
| O03 | P1 | `每个产物都用中文文件名，最后按 图片 / 视频 / 文档 / 表格 / 页面 分组` | Clean grouped manifest. | Stable final layout; no inflated task counts. |
| O04 | P1 | `做 3 张图、1 个 PPT、1 个 Excel，图片完成一张就先显示` | Partial media appears as it completes. | Progressive artifact rendering. |

### P. Follow-Up, Revision, And Run Isolation

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| P01 | P0 | After O01 restart: `刚才生成了哪些文件？逐个给我路径` | Recover complete artifact manifest. | No "only video remains" regression. |
| P02 | P0 | After N02: `把客单价改成 199，并更新相关公式` | Revise workbook or create a revised copy. | Prior artifact lookup and edit flow. |
| P03 | P1 | After N01: `把 PPT 改成更适合老板看的版本` | Create executive revision from prior deck. | Prior PPT lookup, not generic advice. |
| P04 | P0 | Session A generates video while Session B asks `你是谁？` | Separate sessions remain isolated. | No task panel/history cross-contamination. |
| P05 | P0 | During video generation: `再给我写 3 条朋友圈文案` | Queue or separate run with clear ownership. | Second turn not swallowed into video run. |

### Q. User-Facing Process And Failure Tone

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| Q01 | P0 | `普通聊天：你现在能做哪些文件类产物？` | Capability answer, no graph. | No Main Agent/Gate expansion. |
| Q02 | P0 | `随便生成一张图片，不要展示技术细节` | Lightweight progress and final image. | No raw branch/gate spam. |
| Q03 | P1 | `生成失败的话，别卡住，告诉我失败原因和下一步` with forced provider failure | Friendly failure summary and retry path. | No permanent "进行中" or raw stack/code leak. |

### R. Long-Form Content Completion

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| R01 | P0 | `生成10000字的灵异类小说` | Plan, generate, save, read back, and iteratively repair until the requested length is satisfied. | A preface or opening chapter cannot pass; one canonical artifact card only. |
| R02 | P0 | After an interrupted or short R01 result: `完整的呢？` | Continue the unresolved structured length contract without restarting blindly. | Non-retriable parameter errors are surfaced precisely; no repeated blind 502 retries. |
| R03 | P1 | `如何写一篇10000字小说？` | Answer as knowledge guidance without creating a file. | Length wording alone must not authorize an artifact side effect. |

### X. External-Data Web Artifacts

These prompts cover front-end/demo requests that need external data, live fetch fallbacks, preview validation, and clean artifact gates.

| ID | Priority | Prompt | Codex Expected Behavior | UClaw Observation Focus |
| --- | --- | --- | --- | --- |
| X01 | P0 | `你先帮我前端搭建一个demo，要求从中彩网拉取近100期，然后做个前端分析页面，主要出跨度、和值、前区后区的排列分布情况等基础的条件，不需要搭建后端sql数据库` | Build a runnable local front-end artifact. Attempt live data fetch, handle CORS/Referer failures with embedded snapshot or proxy guidance, verify rendered data and interactions. | Artifact intent/gate correctness, preview validation, recovered error collapse, and concise final manifest. |

## Quality Bar For PPT / Excel / Mini-Program

These artifacts should move from "template-level" to "agent/skill-level".

### PPT Must Have

- The content must be planned by the agent from the prompt or supplied material.
- Prompt-specific outline, not fixed generic sections.
- Deterministic design specification with semantic theme family, audience, purpose, visual tone, and density.
- Product, travel, executive, training, and editorial decks use visibly different cover composition and page frames, not one template with alternate colors.
- Five-page-or-longer decks combine multiple semantic content layouts when the material supports them; layout selection is content-driven rather than random.
- Correct requested page count or clear reason if adjusted.
- Meaningful Chinese page titles and bullets.
- No empty pages, no duplicated titles unless intentional.
- Layout readable at normal slide size.
- File opens in PowerPoint/Keynote or a verifier.
- Verification reads the generated deck metadata/content, not just "file exists".
- Verification reads the theme signature and rendered layout markers; cross-topic regression compares at least one product deck with one travel deck.
- Final reply states file created and verification result.

### Excel Must Have

- The workbook structure must be planned by the agent from the prompt or supplied data.
- Requested sheets and columns.
- Formulas where the task implies calculation.
- Meaningful sample data when user asks for examples.
- Basic formatting: headers, widths, numeric formats.
- Formula summary or validation when asked.
- File opens in Excel/Numbers/LibreOffice or a verifier.
- Verification reads the generated workbook, including sheet names and formula cells when present.

### Mini-Program / Web App Must Have

- The app behavior must be planned by the agent from the prompt, not produced by a fixed static template.
- Runnable local artifact.
- Real interactive behavior, not static mock text.
- State changes visible after user action.
- No obvious layout overlap on desktop and narrow viewport.
- Basic validation/error states when forms are present.
- Final reply tells user how it was verified.

## Agent/Skill Artifact Upgrade Bar

PPT, Excel, and mini-program/web-app tasks should treat the local file generator as the low-level writer, not the whole product experience.

The acceptable target flow is:

1. Planner detects an artifact task and creates a typed subtask.
2. Agent/skill prepares prompt-specific content, data model, app behavior, and file name.
3. A local artifact tool writes the real file.
4. A validator opens or reads the file and records concrete evidence.
5. The final manifest lists the artifact and the verification result.

Template-only fallback is allowed only as a recoverable degraded mode, and must be visible in the result log as a quality failure for P0/P1 artifact prompts.

## Gap-To-Implementation Mapping

| Gap If Observed | Likely Implementation Work |
| --- | --- |
| UClaw asks user to choose one mode for composite prompt | Planner must support composite intent to subtask queue. |
| Results appear live but disappear after restart | Persist durable artifact manifest or transcript entry for final result. |
| Video blocks all other artifacts from being visible | Progressive artifact manifest updates, not final-only delivery. |
| PPT/Excel/mini-program are fixed templates | Route these tasks through agent/skill generation and verification instead of local static generator defaults. |
| Ordinary chat shows execution graph | Compact UI gating must hide graph unless real user-visible work exists or developer mode is on. |
| Second prompt enters first task panel | Run/session isolation, queued turns, and run ownership checks. |
| Image/video local time far exceeds provider time | Add timing trace for planner, queue, provider, download, save, history reload, render. |
| Broken video shown as success | Add media availability/playability validation before gate pass. |
| Follow-up cannot find prior artifact | Artifact manifest lookup and revision routing. |
| Internal gate/code text visible | Map gate failures to user-facing recovery summaries. |

## First Manual Run Order

Run these first before expanding to the full suite:

1. A01
2. B01
3. B05
4. C01
5. G01
6. D01
7. E01
8. F01
9. H01
10. I01
11. J01
12. K01

This first dozen covers the highest-risk product gaps: normal chat cleanliness, media performance, composite delivery, history recovery, office/web artifact quality, multi-run isolation, missing-input recovery, and process display.

## Result Log Template

Copy one block per executed prompt.

```md
### Result: <ID> - <date/time>

- Prompt:
- Environment:
  - Codex desktop:
  - UClaw branch/version:
- Codex actual:
  - Intent:
  - Progress display:
  - Artifacts:
  - Final response:
  - Elapsed:
- UClaw actual:
  - Route/mode:
  - Progress display:
  - Artifacts:
  - Final response:
  - Elapsed:
  - Restart/history result:
- Scores:
  - Intent:
  - Autonomy:
  - Artifact:
  - Quality:
  - Progress:
  - History:
  - Performance:
  - Recovery:
- Gap classification:
  - Existing bug:
  - Product gap:
  - Engineering inference:
  - Codex behavior delta:
- Required implementation:
- Evidence links/screenshots/artifact paths:
```

## Initial Result Log

No benchmark rows have been executed yet in this file. Start with the first manual run order above.
