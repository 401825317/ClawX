# UClaw vs Codex Experience Benchmark Results

Date: 2026-07-09

Branch under review: `feature/uclaw-agent-runtime-contract`

UClaw package version observed in dev logs: `0.7.3`

## Evidence Rules

- `observed`: manually observed in the product or directly reproduced.
- `codex-baseline`: Codex desktop external visible behavior baseline; not a claim about Codex internals.
- `uclaw-code-evidence`: based on source code evidence and still needs product UI confirmation.
- `user-observed`: based on user-provided UClaw run output in this thread.

## First Batch Summary

| ID | Prompt Area | Current UClaw State | Codex Baseline Delta | Priority |
| --- | --- | --- | --- | --- |
| A01/K01 | ordinary chat / memory preference | Current session evidence shows no media/artifact side effects, but Electron UI still needs confirmation that the process graph is hidden by default. | Codex keeps this as a short conversational/memory confirmation without graph noise. | P0 |
| B01/J01 | image generation timing | Current dev runs show image generation works, but timing varies widely: one smoke was about 29.9s total, H01 images took about 79s and 151s wall time with provider header waits of 68.6s and 132.2s. Provider-vs-local reconciliation remains required. | Codex shows calm progress and final artifact; it does not make the user debug raw gate internals. | P0 |
| B05/I04 | video generation/playback | User observed a broken/0s video case before. Must re-run current build and require duration/playability evidence. | Codex should not mark a broken media artifact as successful. | P0 |
| C01/G01/K03 | seven-item composite pack | Composite routing and history persistence have improved, but user still saw messy final layout, confusing task count, and only-final delivery. | Codex-style behavior is a compact sample pack manifest with completed/failed/pending items. | P0 |
| D01 | PPT quality | Code has local PPT writers and skill shims, but composite fast path can still create prompt-light template-like decks. | Codex-level output needs prompt-specific deck planning plus verification. | P0 |
| E01 | Excel quality | Code can create `.xlsx` with formulas, but composite fast path can still create a generic budget-style table. | Codex-level output needs prompt-specific workbook planning, formulas, sheet validation. | P0 |
| F01 | mini-program quality | Code can create an HTML app, but default behavior is a fixed Todo-like template unless the agent plans content/behavior. | Codex-level output needs runnable, prompt-specific interactions and verification. | P0 |
| H01/H02 | multi-run isolation | H01 produced separate cat/dog image tasks; H02 kept a normal chat turn independent while video generation was running. Both image and video completions still persisted internal/inter-session pseudo-user messages in the transcript. | Codex keeps turns/run ownership separate and hides internal completion plumbing from chat history. | P0 |
| I01 | missing image for edit | Single image-edit without image should ask for input; composite sample packs may use generated image as fallback. | Codex does not block the whole batch on one missing optional input. | P0 |
| X01 | front-end demo with external data | Observed ZHCW demo eventually delivered, but the run was noisy, slow, and artifact intent/gate state was inconsistent. | Codex-style behavior should hide recovered internal retries and deliver a verified runnable artifact with concise caveats. | P0 |

## Code Evidence Anchors

- Composite planner detects multi-deliverable prompts in `electron/utils/media-intent-planner.ts`.
- Composite execution runs locally in `src/stores/chat.ts`.
- Composite local Office/web artifacts are created via `/api/local-artifacts/create`.
- Local artifact generation is implemented in `electron/utils/local-artifact-runtime.ts`.
- Bundled low-level artifact tools exist in `resources/openclaw-plugins/uclaw-local-artifacts/index.mjs`.
- Prompt-facing skill shims exist in `resources/openclaw-skill-shims/presentation-maker/SKILL.md` and `resources/openclaw-skill-shims/spreadsheet-maker/SKILL.md`.

## Current Key Finding

The current system has two different artifact paths:

1. Agent/skill path: the model can use `create_pptx_file`, `create_xlsx_file`, and related tools after planning content.
2. Composite fast path: UClaw can bypass agent planning and call local artifact creation directly for PPT/Excel/mini-program/copywriting subtasks.

That second path is why "there is a file" can pass while "Codex-quality artifact" still fails.

## Implementation Update - 2026-07-09

Run kind: `uclaw-code-evidence`

This branch now upgrades the composite fast path from fixed local templates to a first-stage prompt-aware artifact runtime:

- Composite PPT/Excel/mini-program/copywriting tasks pass `sourcePrompt` into `/api/local-artifacts/create`.
- `electron/utils/local-artifact-runtime.ts` plans prompt-specific content before writing files.
- PPT verification opens the generated `.pptx` package, reads slide text, checks slide count, empty slides, and duplicate titles.
- Excel verification opens the generated `.xlsx` package, reads sheet names, row count, formula count, and formula cell evidence.
- Mini-program verification checks the generated HTML for required prompt-specific behaviors such as delete/filter/search/tags/persistence/form validation/success state/cart/Kanban/list.
- The renderer emits required `artifact.content` verification events into the runtime contract, not just `artifact.availability`.
- A focused unit test now covers sourcePrompt-planned PPT, Excel, Todo app, idea collector, signup form, coffee menu/cart, and Kanban artifacts.
- Media intent planning now has local guards for mode-hint non-media prompts: negated generation, prompt drafting, media mode explanation, video parameter questions, and text-only copywriting in image/video mode remain ordinary chat.

Boundary:

- This is not yet a full child-agent/skill execution model. It is a pragmatic first layer that makes the local writer behave like a planned-and-verified artifact producer.
- Manual UClaw UI runs are still required for process display, final manifest layout, history reload, media/video validity, and concurrent turn isolation.

## Required Implementation Items

### P0. Preserve Unified Planner, But Upgrade Local Artifact Subtasks

For `presentation`, `spreadsheet`, `mini_program`, and likely `copywriting` subtasks, composite execution should not treat `createLocalArtifact(...)` as the full task implementation.

Target behavior:

- The subtask gets a prompt-specific content plan.
- The low-level writer creates the file.
- A validator reads the actual artifact.
- The final manifest includes artifact path plus verification evidence.

Current status:

- First-stage prompt-aware planning and artifact-content verification are implemented in the local artifact runtime.
- Full OpenClaw child-agent/skill orchestration remains a later implementation item if manual benchmarks show the heuristic planner is not enough.

### P0. Add Artifact Validators

PPT validator:

- File exists and is non-empty.
- `.pptx` package opens as zip.
- Slide count matches request or is explained.
- Slide titles are non-empty and not all duplicates.
- No obviously empty slides.

Excel validator:

- File exists and is non-empty.
- Workbook opens.
- Expected sheet count/names are present when requested.
- Formula cells are detected when calculations are requested.
- Validation can report formula addresses.

Mini-program/web validator:

- File exists and is non-empty.
- HTML parses and contains script/interactive controls when requested.
- Playwright or lightweight DOM check verifies at least one expected interaction for P0 prompts.
- Basic viewport check catches obvious text/control overlap.

### P0. Manifest And UI Cleanup

- Keep one compact user-facing composite progress card.
- Do not show raw branch/gate/error code details unless developer details are expanded.
- Final message should use a stable manifest:
  - completed artifacts
  - failed or skipped subtasks
  - inputs still needed
  - verification summary
- Fix confusing task counts such as "12 tasks completed" when the user asked for seven deliverables.

### P0. Run Isolation

- Each user turn must own exactly one run id.
- A second prompt while image/video/composite is running must be queued or shown as a separate run, never injected into the first run panel.
- Session switching must not mix task panels or final manifests.

### P1. Performance Accounting

- Preserve real-time cumulative user-facing elapsed time.
- Keep detailed timing internally:
  - planner
  - queue wait
  - provider request
  - provider response/download
  - local save
  - validation
  - transcript persistence
  - render/history refresh
- Final media tasks should expose total time compactly, not raw implementation steps.

### P0. External-Data Front-End Demo Reliability

For requests like "build a front-end demo that pulls data from an external site/API", do not add one-off rules for the specific site. Treat this as a general artifact pattern:

- Planner must classify "搭建 demo / 做页面 / 做小程序 / 分析页面" as an artifact task with required file delivery.
- The execution plan should expect CORS, Referer, anti-hotlink, or empty-200 responses from external data sources.
- The default deliverable should include a robust fallback such as embedded snapshot data or a lightweight no-SQL proxy recommendation, while still attempting live fetch when feasible.
- Verification should validate the generated file, local preview, rendered data count, and at least one interaction.
- Recovered browser/server/tool failures should be collapsed from the normal user view; developer details can keep them.
- Gate state must not end with contradictory `verificationPassed=true` and `verificationBlocked=true` semantics.

## Manual Run Queue

Run these next and append rows below:

1. A01
2. K01
3. C01
4. G01
5. D01
6. E01
7. F01
8. H01
9. B01/J01
10. B05/I04

## Result Rows

### Result: C01 - user-observed before current benchmark file

- Prompt: `生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个`
- Codex baseline:
  - Intent: treat as a sample pack request, not a mode conflict.
  - Progress display: compact progress, no raw routing/gate spam.
  - Artifacts: image, PPT, Excel, video, edited image or clear fallback, runnable app, copywriting.
  - Final response: artifact manifest with verification summary.
- UClaw actual from user-observed runs:
  - Earlier reply asked user to choose one task, which is a P0 failure.
  - Later composite execution produced artifacts, but final layout was messy and task count was confusing.
  - A history regression showed only the video after reopening; this was later addressed by persisting a composite final transcript entry.
- Gap classification:
  - Existing bug: final manifest/UI quality and task count still need verification.
  - Product gap: progressive delivery and agent/skill-grade local artifacts are not complete.
  - Engineering inference: local template fast path is still too shallow for PPT/Excel/mini-program quality.
- Required implementation:
  - Upgrade local artifact subtasks to agent/skill-planned generation plus validation.
  - Stabilize compact manifest rendering and task counting.
  - Re-run G01 after every change.

### Result: D/E/F Quality - uclaw-code-evidence

- Prompts:
  - D01: `做一个 8 页 PPT：《AI 工作流如何提升团队效率》，要有目录、痛点、方案、案例、ROI、落地计划`
  - E01: `做一个月度预算 Excel，包含预算、实际、差额、完成率、合计和图表`
  - F01: `做一个可运行的 Todo 小程序，有新增、完成、删除、筛选`
- Codex baseline:
  - Plan content from the prompt, create durable artifact, verify the artifact, then summarize the result.
- UClaw code evidence:
  - Low-level local writers exist for PPT/XLSX/HTML.
  - Composite local execution can call these writers directly.
  - Direct writer fallback can satisfy "file exists" while failing prompt-specific quality.
- Required implementation:
  - Treat the writer as a tool, not the agent.
  - Add validators and require verification evidence before final gate passes.

### Result: Local Artifact Runtime Upgrade - uclaw-code-evidence after implementation

- Prompts covered by unit tests:
  - D-style PPT: `请制作 4 页 PPT，主题是《本地交付验证》。包含背景、方案、验证、下一步。`
  - N02-style Excel: `做一个 Excel：20 条模拟销售数据，含线索、商机、成交率、客单价、预计收入；生成后列出公式单元格`
  - F01-style app: `请做一个 Todo 小程序，需要输入任务、删除任务、按全部/进行中/已完成筛选。`
  - F02-style app: `做一个灵感收集小工具，支持标签、搜索、本地保存`
  - F03/N03-style app: `做一个活动报名页面，包含表单校验、报名成功状态、报名列表和本地保存`
  - F04-style app: `做一个咖啡店菜单小程序，可以按分类筛选并计算购物车总价`
  - F05-style app: `做一个销售线索 Kanban，小卡片可以拖动或至少切换状态`
- UClaw code evidence:
  - PPT verification reports `slides=<n>` and title evidence from the actual `.pptx`.
  - Excel verification reports `formulaCells=...` from the actual `.xlsx`.
  - HTML verification reports prompt-specific capability booleans such as `hasSearch`, `hasTags`, `hasValidation`, `hasSuccess`, `hasCart`, and `hasKanban`.
- Verification commands:
  - `pnpm harness validate --spec harness/specs/tasks/uclaw-codex-experience-benchmark.md --no-diff`
  - `pnpm exec vitest run tests/unit/local-artifact-runtime.test.ts`
  - `pnpm exec vitest run tests/unit/chat-target-routing.test.ts tests/unit/uclaw-local-artifacts-plugin.test.ts`
- Test result:
  - Harness spec valid.
  - Local artifact runtime tests passed: 8 tests.
  - Existing targeted regression tests passed: 29 tests.

### Result: L01-L05 Mode Hint Guard - uclaw-code-evidence after implementation

- Prompts covered by unit tests:
  - L01: `先别生成图片，帮我写 3 条适合生图的提示词`
  - L02: image mode + `解释一下图片模式和普通聊天有什么区别`
  - L03: video mode + `我现在不生成视频，只想知道默认视频参数是什么`
  - L04: `以后我说做海报时，默认先找参考图，但这次别生成`
  - L05: image mode + `图片模式里帮我写一段朋友圈文案`
  - Guardrail: `不要生成图片，只生成视频` still routes to video generation, so negated image generation does not suppress an explicit redirected media request.
- Expected UClaw behavior:
  - `action=chat`
  - `currentTurnMediaRequest=false`
  - no image/video generation
  - no LLM planner call needed for these high-confidence local guards
- Verification command:
  - `pnpm exec vitest run tests/unit/media-intent-planner.test.ts`
- Test result:
  - Media intent planner tests passed: 20 tests.

### Result: K01 Process Display Cleanup - uclaw-code-evidence after implementation

- Problem observed in the afternoon UClaw runs:
  - Ordinary chat and preference turns could still show a collapsed execution card because the page treated elapsed-time evidence alone as enough reason to render a run surface.
  - This conflicts with the Codex desktop baseline: simple chat should just show the answer/typing state, while detailed run internals remain developer diagnostics.
- Implementation:
  - `src/pages/Chat/index.tsx` now requires a concrete user-facing execution surface before rendering `ExecutionGraphCard`.
  - Valid render reasons are generated files, composite task steps, structured media/artifact runtime kinds, known user-facing artifact/media tools, or user-facing artifact/media failures.
  - Elapsed time still appears for image/video/file/composite work, but elapsed time alone no longer makes ordinary chat display an execution card.
  - The filter intentionally avoids keyword-only matching for normal activity, so prompts like "默认图片素材来源是什么" do not show a run card just because the text contains "图片".
- Verification:
  - No unit test was run per product-testing preference in this session.
  - Lightweight Vite transform check passed for `src/pages/Chat/index.tsx`.
- Remaining confirmation:
  - Electron-window visual check still required for A01/K01/A05/L02/L04 to confirm ordinary chat shows no execution card.
  - Media/file/composite prompts must still show compact elapsed progress.

### Result: B05 Video Generation - observed via dev Gateway session

- Prompt: `随便生成一个短视频`
- Session:
  - `sessionKey=agent:main:codex-smoke-video-1783588501595`
  - `sessionId=3f71a421-136b-448a-bdb6-82dd75c88427`
- Codex baseline:
  - Start one video task, show compact progress, and either deliver a playable video with duration evidence or a concise recoverable failure.
- UClaw actual:
  - Planner correctly authorized `video_generate` for the current media task.
  - The video task started with 16:9, 720P, 5s, no audio, no watermark.
  - Provider task failed after `120000ms` with timeout and produced no media file.
  - Final visible reply was concise: video generation timed out and no downloadable file was produced.
  - The outer self-test waiter still timed out at about 603s with zero captured final chars, even though the session file had a final failure reply at about 141s.
- Gap classification:
  - Provider timeout is an acceptable recoverable media failure, not a false success.
  - Existing bug: async media completion/failure is persisted to the session, but external waiters/history polling can miss the final assistant text and keep waiting.
  - Product gap: video progress should surface provider timeout/retry options compactly and stop all pollers promptly.
- Required implementation:
  - Normalize video task failure into the same run completion signal consumed by UI, history polling, and test waiters.
  - Keep final media gate strict: no video file means no successful media artifact.
  - Add duration/playability validation only for successful video outputs.

### Result: X01 External-Data Front-End Demo - observed

- Prompt: `你先帮我前端搭建一个demo，要求从中彩网拉取近100期，然后做个前端分析页面，主要出跨度、和值、前区后区的排列分布情况等基础的条件，不需要搭建后端sql数据库`
- Session:
  - `sessionKey=agent:main:session-1783587778423`
  - `sessionId=3d4e3f8c-5141-4536-9df9-a76e07e04e07`
- Codex baseline:
  - Treat as a runnable front-end artifact request.
  - Use external source evidence, but plan for CORS/Referer restrictions.
  - Deliver a concise final artifact manifest plus validation result; internal retries stay hidden.
- UClaw actual:
  - Final artifact exists: `/Users/huajing002/.openclaw/workspace/zhcw-dlt-analysis-demo-20260709.html`.
  - The generated page includes 100 embedded ZHCW snapshot rows and a fallback message because direct local static JSONP can return empty body without the official Referer.
  - Runtime duration was about 11 minutes with 38 tool calls and 5 recovered internal errors.
  - Recovered errors included browser `targetId` mismatch, Node `require` plus top-level `await` ambiguity, and a local preview server connection refusal.
  - Artifact guard classified the final run as `artifactRequest=false` even though the prompt required a demo file.
  - Final gate evidence contained contradictory state: `verificationPassed=true`, `verificationBlocked=true`, `explicitBlocker=true`, and `shouldRevise=false`.
- Gap classification:
  - Existing bug: artifact intent detection misses "front-end demo / analysis page" tasks.
  - Existing bug: recovered blockers are not normalized before final gate status.
  - Product gap: recovered internal tool/server failures are too visible/noisy in the process trace.
  - Product gap: external-data demo tasks need a default fallback/proxy pattern instead of discovering it through long trial-and-error.
- Required implementation:
  - Extend artifact intent and planner contract for front-end demo/web app/data-analysis pages.
  - Add a generic external-data artifact pattern with live fetch plus embedded snapshot or proxy recommendation.
  - Stabilize local preview server lifecycle during validation.
  - Normalize final gate state after recovery and collapse recovered errors from the default UI.

### Result: Current Dev Self-Test Batch - observed via Gateway sessions

Run kind: `observed`

Environment:

- UClaw branch: `feature/uclaw-agent-runtime-contract`
- Dev mode: `pnpm run dev:junfeiai`
- Host API: `127.0.0.1:13210`
- OpenClaw Gateway: `127.0.0.1:18789`
- Evidence sources:
  - `openclaw sessions --json --limit 20`
  - `openclaw gateway call chat.history`
  - Session transcript files under `/Users/huajing002/.openclaw/agents/main/sessions`

#### A01 / Ordinary Memory Preference

- Prompt: `普通聊天：以后生成作品的时候，如果需要图片就从网上获取，保存在记忆体里`
- Session:
  - `sessionKey=agent:main:codex-smoke-ordinary-memory-1783587813444`
  - `sessionId=980dfdde-2333-464e-8042-6d8ab6074863`
- UClaw actual:
  - Did not route to image/video generation.
  - Tried `memory_search`; embedding provider failed with `model_not_found`.
  - Recovered by reading `/Users/huajing002/.openclaw/workspace/MEMORY.md`.
  - Final reply confirmed the preference in Chinese.
- Current judgment:
  - Intent: pass.
  - Recovery: pass with caveat.
  - Product gap: memory embedding/provider failure should be hidden or downgraded in normal UI; user should only see the final preference confirmation.

#### A02 / Chinese Result And Filename Preference

- Prompt: `你记住，我以后默认喜欢中文结果，文件名也用中文`
- Session:
  - `sessionKey=agent:main:codex-smoke-a02-1783590879`
  - `sessionId=e6572ed7-d27c-4a75-9e0f-6eaa69de76ce`
- UClaw actual:
  - Media planner classified the turn as `preference_or_memory_update`.
  - No image/video generation was started.
  - The agent attempted `memory_search`; embedding provider failed with `model_not_found`.
  - The agent recovered by reading and editing `/Users/huajing002/.openclaw/workspace/MEMORY.md`.
  - Final reply confirmed the preference in Chinese.
- Current judgment:
  - Intent: pass.
  - Memory persistence: pass through file-backed fallback.
  - Product gap: memory embedding failure still creates noisy internal tool activity and latency; normal users should only see the preference confirmation unless developer details are expanded.

#### Q01 / Capability Question

- Prompt: `你现在能做哪些文件类产物？`
- Session:
  - `sessionKey=agent:main:codex-smoke-capability-1783587795447`
  - `sessionId=d16a01a8-e0f2-469c-9077-f80cf4af73e3`
- UClaw actual:
  - Returned a direct capability answer.
  - No media generation or artifact side effect.
  - Answer listed Word/PPT/Excel/Markdown/HTML/code/image/video/PDF/file editing.
- Current judgment:
  - Intent: pass.
  - Autonomy: pass.
  - UI cleanliness still needs Electron-window visual confirmation because session evidence does not prove whether the runtime panel was hidden.

#### I02 / Unsafe Desktop Action

- Prompt: `帮我打开微信并给Uclaw技术保障群发一条消息，内容你随便生成`
- Session:
  - `sessionKey=agent:main:codex-smoke-wechat-blocker-1783587878909`
  - `sessionId=f5cb6a41-6e88-4ced-a3bc-efd7fa0b20f1`
- UClaw actual:
  - Did not use the disabled/unreliable desktop connector.
  - Clearly said it could not reliably operate WeChat and did not send.
  - Provided a copyable draft message.
- Current judgment:
  - Intent: pass.
  - Safety/recovery: pass.

#### D01 / PPT File Artifact

- Prompt: `帮我做一个 3 页《AI 工作流效率提升》PPT，内容你随便生成，必须保存成真实本地文件`
- Session:
  - `sessionKey=agent:main:codex-smoke-artifact-ppt-1783587959193`
  - `sessionId=1cc674bf-0144-4e18-9acd-8f943c3a6db2`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/AI工作流效率提升_3页.pptx`
- UClaw actual:
  - Used `create_pptx_file`.
  - Verified with `ls` and `file`; result was Microsoft OOXML.
  - Final reply included the file path and `MEDIA:` line.
- Current judgment:
  - Artifact: pass for real-file delivery.
  - Quality: partial; this smoke is a 3-page basic deck, not the full D01 8-page executive quality bar.

#### E01 / Excel File Artifact

- Prompt: `帮我生成一个月度预算 Excel，带公式，必须保存成真实本地文件`
- Session:
  - `sessionKey=agent:main:codex-smoke-artifact-excel-1783588001511`
  - `sessionId=365813b3-553c-484a-b35f-82527d397d16`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/monthly_budget_with_formulas_20260709.xlsx`
- UClaw actual:
  - Used `create_xlsx_file`.
  - Generated multiple sheets and formulas such as summary totals, `SUMIF`, remaining budget, and usage rate.
  - Final reply included `MEDIA:` path.
- Current judgment:
  - Artifact: pass.
  - Quality: partial pass; formula evidence exists in tool arguments, but final reply did not list exact formula cells from the actual workbook in this smoke.

#### F01 / Mini-Program HTML Artifact

- Prompt: `做一个 Todo 小程序，单文件 HTML 就行，必须保存成真实本地文件`
- Session:
  - `sessionKey=agent:main:codex-smoke-artifact-miniapp-1783588049540`
  - `sessionId=fbeb6a70-f170-4bf6-b735-eed85044312f`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/todo-miniapp-20260709-1707-a8f3.html`
- UClaw actual:
  - First `create_html_app_file` produced a 206-byte empty shell.
  - Agent detected the bad artifact by reading it.
  - Agent repaired it with `write`, producing a 14 KB single-file app with inline CSS/JS.
  - Final reply listed interactions: add, complete, delete, double-click edit, filters, clear completed, local browser storage.
- Current judgment:
  - Recovery: pass.
  - Artifact: pass after repair.
  - Product gap: low-level local HTML writer can still emit an empty shell; this must be fixed at the writer/validator layer so the agent does not need a visible repair detour.

#### B01 / Image Generation

- Prompt: `随便生成一个图片`
- Session:
  - `sessionKey=agent:main:codex-smoke-image-1783588411849`
  - `sessionId=7e1740a6-969b-4113-834c-b4f6b4be53cc`
- Artifact:
  - `/Users/huajing002/.openclaw/media/tool-image-generation/surprise_abstract_cat---942af18c-9af9-4aa4-bbf6-f85365fa59cc.png`
- UClaw actual:
  - Planner authorized `image_generate`.
  - Final assistant reply restored through `chat.history`.
  - Gate passed with required artifact evidence.
- Current judgment:
  - Intent/artifact: pass.
  - Performance/UI: needs Electron-window confirmation for compact progress and provider-vs-local timing display.
  - Timing evidence from this smoke:
    - user message to image tool call: about `7547ms`
    - image tool call to background-task ack: about `7728ms`
    - background ack to completion event: about `14572ms`
    - completion event to final assistant reply: about `5ms`
    - user message to final assistant reply: about `29852ms`
  - Performance judgment: pass for this sample, but not enough to explain user-observed 88-100s runs without provider/proxy log correlation.

#### B05 / Video Failure Recovery

- Prompt: `随便生成一个短视频`
- Session:
  - `sessionKey=agent:main:codex-smoke-video-1783588501595`
  - `sessionId=3f71a421-136b-448a-bdb6-82dd75c88427`
- UClaw actual:
  - Planner authorized `video_generate`.
  - Provider task timed out and produced no video file.
  - Final assistant reply was restored through `chat.history`: the video generation failed, no downloadable file was produced, and user can retry.
  - `sessions.list` reports `status=done`, `hasActiveRun=false`.
- Current judgment:
  - False-success prevention: pass.
  - Recovery wording: pass.
  - Existing bug remains: earlier external self-test waiter missed the final reply even though `chat.history` had it.

#### C01 / Composite Seven-Deliverable Pack

- Prompt: `生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个`
- Main observed session:
  - `sessionKey=agent:main:main`
  - `sessionId=3e6affb1-c1f0-4b86-8591-0b15fc347caf`
- UClaw actual:
  - Older runs split the same user prompt into separate assistant replies such as image-only, image-edit-only, and video-only; one run also had an assistant failure row.
  - Later run produced a unified Codex-style sample pack:
    - theme: `未来城市里的个人效率工作台`
    - final text says `已完成 7 项`
    - includes generated image, PPT, Excel, video, edited image, HTML mini app, and copywriting.
  - `chat.history` now restores the unified 7-item final reply, but it also restores the older split-message attempts in the same session.
- Current judgment:
  - Composite intent: improved; no longer asks the user to choose one mode in the later run.
  - Artifact manifest: partial pass; final manifest is compact enough in transcript, but UI layout still needs visual confirmation.
  - History: partial pass; the final 7-item reply survives `chat.history`, but older split runs are still visible and can make the session feel noisy.
  - Product gap: one user prompt should map to one run-owned visible result; old-style split replies must be collapsed or scoped under one compact progress/result card.

#### G01 / History Reload After Composite

- Check: `openclaw gateway call chat.history` against `agent:main:main`.
- UClaw actual:
  - The later C01 unified final reply is present in the Gateway history projection.
  - `sessions.list` reports `agent:main:main` as `status=done`, `hasActiveRun=false`.
  - The earlier "only video remains" style rows are still present in the same transcript from prior runs.
- Current judgment:
  - Backend history persistence: partial pass.
  - UI reload correctness: not fully proven without Electron visual inspection.
  - Required next check: reopen the Electron session and confirm the visible final answer is the unified 7-item manifest, not a single video row or interleaved raw task fragments.

#### L01 / Image Mode Prompt-Only Guard

- Prompt: `图片模式：先别生成图片，帮我写一段未来城市海报提示词`
- Session:
  - `sessionKey=agent:main:codex-smoke-image-prompt-only-1783587855012`
  - `sessionId=65aef0e9-72e2-4741-8f19-398cf62397d6`
- UClaw actual:
  - Returned prompt text only.
  - No image generation artifact was produced.
- Current judgment:
  - Side-effect guard: pass.

#### L03 / Video Mode Parameter Question

- Prompt: `视频模式：你现在用的视频模型是什么？不要生成视频`
- Session:
  - `sessionKey=agent:main:codex-smoke-video-model-question-1783587872495`
  - `sessionId=2b987f2f-0760-423b-b069-52119f346271`
- UClaw actual:
  - First answer said current text model was `lingzhiwuxian/smart-latest`.
  - Then called `video_generate` with `action=list`, not generation.
  - Final answer said configured video default was `openai/sora-2`.
- Current judgment:
  - No video side effect: pass.
  - Product answer quality: fail/needs follow-up. The answer should distinguish default chat model from UClaw video generation model and use current UClaw config, not expose a raw upstream/static model list if it differs from the configured product default.

#### K01 / Ordinary Chat Process Cleanliness

- Prompt: `普通聊天：给我 3 个适合做 AI 产品周报的标题`
- Session:
  - `sessionKey=agent:main:codex-smoke-k01-17835902343n`
  - `sessionId=78e62d0a-bcff-4086-87ae-2101131392c8`
- UClaw actual:
  - Media planner classified as `ordinary_chat`.
  - No tool calls.
  - Final answer returned three text titles:
    - `AI 产品进展周报：功能迭代、用户反馈与下周计划`
    - `智能化产品周报：数据表现、能力更新与风险跟进`
    - `AI 产品运营周报：核心指标、版本动态与重点事项`
  - Final gate had `artifactRequest=false`, `desktopActionRequest=false`, and no blockers.
- Current judgment:
  - Intent: pass.
  - Side effects: pass.
  - UI cleanliness still needs Electron-window visual confirmation because CLI/session evidence cannot prove whether the execution graph is hidden by default.

#### I01 / Missing Image For Edit

- Prompt: `根据图片修图，随便修一下`
- Session:
  - `sessionKey=agent:main:codex-smoke-i01-17835902343n`
  - `sessionId=3c2d8023-0c35-47f1-8ee3-c569cbd46afb`
- UClaw actual:
  - Media planner local fast path returned `action=clarify`.
  - Reason: `local_fast_path_image_edit_missing_input_image`.
  - No `image_generate` or `image_edit` call was made.
  - Final reply asked user to upload/provide the image path and explained it can then do light retouching.
- Current judgment:
  - Intent: pass.
  - Recovery: pass.
  - This is the correct behavior for standalone image-edit without an attached or prior image. Composite sample packs should remain different: they may use a newly generated image as the edit source.

#### H01 / Same-Session Consecutive Image Runs

- Prompts:
  - First turn: `生成一张猫图`
  - Second turn, sent before the first image finished: `生成一张狗图`
- Session:
  - `sessionKey=agent:main:codex-smoke-h01-17835903903n`
  - `sessionId=8429b0b3-ddf5-47ba-b0f6-a8798502ece8`
- Artifacts:
  - `/Users/huajing002/.openclaw/media/tool-image-generation/cat_20260709---1817982a-0c2d-47ff-bfd8-bc1cf1b433ad.png`
  - `/Users/huajing002/.openclaw/media/tool-image-generation/dog_20260709---f8078ac6-f729-45e5-b6d5-e201d86d8800.png`
- UClaw actual:
  - The first turn planned and called one `image_generate` tool for the cat image.
  - The second turn planned and called one separate `image_generate` tool for the dog image.
  - Both images were generated and final assistant replies were appended: `猫图已生成` and `狗图已生成`.
  - The second prompt did not replace the first prompt's tool arguments; run-level intent stayed separate.
  - However, each async image completion was injected into the same transcript as a long internal/inter-session pseudo-user message before the visible assistant reply.
- Timing evidence:
  - Cat request: tool request started at `17:46:46`; provider headers returned after `68639ms`; image saved at `17:47:56`; final visible reply at `17:49:18`.
  - Dog request: tool request started at `17:47:04`; provider headers returned after `132152ms`; image saved at `17:49:18`; final visible reply at `17:49:23`.
  - Both output images are valid PNG files, each `1254x1254`, around `2.2-2.3MB`.
- Current judgment:
  - Run isolation: partial pass. The two user intents did not overwrite each other.
  - History cleanliness: fail. Internal completion events should not appear as user-message transcript items.
  - UI risk: high. Even if the visible renderer hides some internals, persisted pseudo-user rows can explain messy reload/history behavior.
  - Performance: fail/needs investigation for this sample because provider header wait dominated at `68.6s` and `132.2s`.
- Required implementation:
  - Store async media completion as run/artifact events attached to the owning user turn, not as normal user messages.
  - Ensure history projection and UI collapse internal completion events by default.
  - Add run ownership metadata so completion events update the correct progress/result card without polluting chat history.
  - Keep detailed timing internally but show only compact user-facing elapsed/progress.

#### H02 / Video Running Then Ordinary Chat

- Prompts:
  - First turn: `随便生成一个短视频`
  - Second turn, sent while video generation was running: `同时给我 3 个适合 AI 产品周报的标题`
- Session:
  - `sessionKey=agent:main:codex-smoke-h02-1783590757`
  - `sessionId=eb88885d-6cf4-43ae-846f-a260fee415d1`
- UClaw actual:
  - The video turn planned and called one `video_generate` tool.
  - The second turn was correctly classified as ordinary chat, not a video continuation.
  - The second turn returned three AI product weekly-report titles while the video task was still running.
  - The video provider timed out after `120000ms`; UClaw produced a concise failure reply and did not retry the same video task.
  - The video completion failure was injected into the same transcript as a long internal/inter-session pseudo-user message before the visible failure reply.
- Current judgment:
  - Run isolation: pass for intent separation. The ordinary chat turn was not swallowed by the video task.
  - Completion propagation: partial pass. The user-visible failure reply was written, but via the same internal pseudo-user-message completion bridge seen in H01.
  - History cleanliness: fail. Async media completion should not become a normal user message in persisted history.
  - Recovery: pass. No false success and no broken video artifact was reported as generated.
- Required implementation:
  - Use a typed async completion event or run update for image/video completions, not a faux user turn.
  - Route completion/failure to the owning run card and final manifest.
  - Keep the second user turn as a separate visible turn with its own run ownership.

#### A03/A04 / Memory Follow-Up And Plain Error Explanation

- Prompts:
  - A03: `我刚才说的默认图片素材来源是什么？`
  - A04: `帮我解释一下这个错误是什么意思：TypeError: Cannot read properties of undefined`
- Session:
  - `sessionKey=agent:main:codex-smoke-a03-a04-1783591109`
  - `sessionId=239d4a8a-b2f7-4735-aa6f-48d6f2cebfb7`
- UClaw actual:
  - A03 recovered the preference from file-backed memory and answered that image material should default to online sources when needed.
  - A04 answered as ordinary chat and explained the JavaScript `undefined` property access error.
  - No image/video generation or artifact creation was triggered.
  - Memory embedding still failed with `model_not_found` and fell back to `MEMORY.md`.
- Current judgment:
  - Intent: pass.
  - Memory/context: pass through fallback.
  - UI/product gap: embedding/provider failure should be normalized as an internal fallback detail and hidden from normal chat UI.

#### D01 / Full PPT Quality And Gate Strictness

- Prompt: `做一个 8 页 PPT：《AI 工作流如何提升团队效率》，要有目录、痛点、方案、案例、ROI、落地计划`
- Session:
  - `sessionKey=agent:main:codex-smoke-d01-1783591108`
  - `sessionId=839c8300-b536-41d8-bd33-954b2718f486`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/AI工作流如何提升团队效率.pptx`
- UClaw actual:
  - A real `.pptx` file was created.
  - Local package inspection showed the file had 9 slides, while the prompt requested 8.
  - The final assistant reply said: `刚才工具自动额外加了一页封面，实际生成了 9 页。我直接重做一个严格 8 页版本并重新校验。`
  - The run ended after that promise. There was no second artifact or successful re-verification in the transcript.
  - The single-artifact prompt was routed through `composite_local` with extra copywriting-like work, which is likely related to confusing task counts in other composite runs.
- Current judgment:
  - Artifact existence: pass.
  - Quality/page-count compliance: fail.
  - Completion gate: fail. A promise to redo is not a completed repair.
  - Planner precision: fail/needs fix. A single PPT request should not inflate into unrelated subtasks.
- Required implementation:
  - Artifact validators must block final success when the actual deck violates requested page count.
  - Final gate must treat promise-only responses such as "I will redo" as unfinished unless a repaired artifact lands.
  - Composite planner should only split truly composite prompts; single PPT requests should stay as one artifact task.

#### E02 / Sales Funnel Excel With Formula Evidence

- Prompt: `做一个销售漏斗 Excel：线索、商机、成交、转化率、预计收入。必须保存成真实本地文件，生成后列出实际用了公式的单元格。`
- Session:
  - `sessionKey=agent:main:codex-smoke-e02-1783591109`
  - `sessionId=28d92f3a-8a7a-49cc-9761-230ae05f691d`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/销售漏斗_20260709_1758.xlsx`
- UClaw actual:
  - Generated a real `.xlsx` file.
  - Final reply listed formula cells:
    - `B5 = B3/B2`
    - `B6 = B4/B3`
    - `B7 = B4/B2`
    - `B9 = B4*B8`
  - Tool arguments show the formulas were passed into the workbook writer.
- Current judgment:
  - Artifact: pass.
  - Formula evidence: pass from transcript/tool arguments, but local workbook XML parsing still needs a reliable verifier so we do not depend on the assistant's own statement.
  - Quality: pass for this prompt's basic business table bar.
- Required implementation:
  - Keep Excel formula-cell verification tied to the actual `.xlsx` package, including shared/inline sheet XML structures.
  - Reuse this formula evidence in final manifest instead of relying on prose.

#### F02 / Interactive HTML App With Final Delivery Failure

- Prompt: `做一个灵感收集小工具，支持标签、搜索、本地保存，单文件 HTML，必须保存成真实本地文件，做完后自己检查主要交互。`
- Session:
  - `sessionKey=agent:main:codex-smoke-f02-1783591109`
  - `sessionId=c2161315-11e0-40f5-95ca-839e05f72976`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/outputs/灵感收集小工具_20260709.html`
- UClaw actual:
  - Generated a real single-file HTML app, about `16259` bytes.
  - The artifact contains search, tags, form controls, localStorage persistence, edit/delete/pin behavior, and client-side render logic.
  - Lightweight local verification found expected capabilities:
    - `hasLocalStorage=true`
    - `hasSearch=true`
    - `hasTags=true`
    - `hasForm=true`
    - script parse OK
  - The run then attempted an additional shell verification and hit `429 Upstream rate limit exceeded` during final assistant completion.
  - The session ended with an assistant error row and no clean final delivery message, even though the artifact exists and appears usable.
- Current judgment:
  - Artifact: pass.
  - Quality: partial pass from local evidence.
  - Delivery/recovery: fail. A finished artifact plus partial verification should still be recoverably deliverable if only the final LLM completion hits rate limit.
- Required implementation:
  - Separate artifact delivery state from final prose generation so already-created files can be surfaced after final model rate-limit failures.
  - Add a fallback final summary generated from structured artifact manifest and verification facts.
  - Keep long app verification cheap and deterministic where possible to avoid burning another full model completion.

#### G02 / Follow-Up Vision On Prior Generated Image

- Prompt sequence:
  - First turn: `随便生成一个图片`
  - Follow-up: `你觉得这张图美嘛？哪里可以优化？`
- Session:
  - `sessionKey=agent:main:codex-smoke-image-1783588411849`
  - `sessionId=7e1740a6-969b-4113-834c-b4f6b4be53cc`
- Prior artifact:
  - `/Users/huajing002/.openclaw/media/tool-image-generation/surprise_abstract_cat---942af18c-9af9-4aa4-bbf6-f85365fa59cc.png`
- UClaw actual:
  - The follow-up correctly found the prior generated image and called the vision `image` tool with that file path.
  - The vision tool produced a detailed image critique.
  - Final delivery then became noisy:
    - one truncated assistant reply was persisted;
    - two additional complete assistant replies with similar content were appended;
    - session state temporarily showed `running` after the tool result before eventually becoming `done`.
  - The original image generation turn still contains an internal inter-session pseudo-user message in history.
- Current judgment:
  - Context/media lookup: pass.
  - User-visible delivery: fail/needs fix. Codex-style behavior should produce one concise final answer, not a truncated draft plus duplicate retries.
  - History cleanliness: fail due to the existing async image completion pseudo-user row.
- Required implementation:
  - De-duplicate final assistant messages for one user turn after tool-result continuation/retry.
  - Ensure a tool-result continuation can replace or complete a draft, not append multiple visible final answers.
  - Keep prior-media lookup behavior, but attach generated-media completion to typed run/artifact state instead of a normal user transcript row.

#### A05 / Plain Text Title Suggestions

- Prompt: `给我 3 个适合做 AI 产品周报的标题`
- Session:
  - `sessionKey=agent:main:codex-smoke-a05-1783593600`
  - `sessionId=ae134528-4de0-4c6d-a562-c0ac7b646e8d`
- UClaw actual:
  - Returned three Chinese titles.
  - No tool calls, no media generation, no artifact creation.
  - Runtime was about `4.2s`.
- Current judgment:
  - Intent: pass.
  - Side effects: pass.
  - This is Codex-like for a plain writing request at the transcript level; Electron UI still needs visual confirmation that no execution graph is shown by default.

#### L02 / Image Mode Explanation Without Image Side Effect

- Prompt: `图片模式：解释一下图片模式和普通聊天有什么区别`
- Session:
  - `sessionKey=agent:main:codex-smoke-l02-1783593600`
  - `sessionId=43144c3e-41a1-4bec-843d-dd0d70c975a5`
- UClaw actual:
  - Returned a text explanation of image mode vs ordinary chat.
  - No `image_generate` or `image_edit` tool call was made.
  - Runtime was about `11.5s`.
- Current judgment:
  - Mode hint guard: pass. The "图片模式：" prefix did not force an image side effect.
  - Product wording: acceptable, though the UI label "图片模式" should remain a mode hint in routing, not a hidden hard override.

#### L04 / Preference Update With Explicit No-Generation

- Prompt: `以后我说做海报时，默认先找参考图，但这次别生成`
- Session:
  - `sessionKey=agent:main:codex-smoke-l04-1783593600`
  - `sessionId=55a40512-6e59-4b85-bd23-817f64b70d9e`
- UClaw actual:
  - Updated `/Users/huajing002/.openclaw/workspace/MEMORY.md` with the poster-reference preference.
  - Did not call image generation or poster artifact generation.
  - Final reply confirmed the preference and explicitly said it would not generate this time.
  - Runtime was about `18.9s`.
- Current judgment:
  - Intent: pass.
  - Side effect guard: pass for media generation.
  - Product/performance gap: preference updates currently still cost a full agent/tool loop and can take ~19s; Codex-like behavior should feel like a short confirmation unless memory write requires visible recovery.

#### H06-lite / Parallel Independent Plain Sessions

- Prompts sent almost concurrently:
  - A05 title suggestions
  - L02 image-mode explanation
  - L04 poster-reference preference update
- UClaw actual:
  - Each prompt landed in its own `sessionKey`.
  - No cross-session transcript contamination was observed.
  - All three sessions reached `status=done`.
- Current judgment:
  - Cross-session isolation for low-cost text/preference turns: pass.
  - This does not yet prove isolation for long media/artifact tasks, which remains covered by H01/H02/H03/H06.

#### E01 / Monthly Budget Excel With Charts And Formula Evidence

- Prompt: `做一个月度预算 Excel，包含预算、实际、差额、完成率、合计和图表，必须保存成真实本地文件，并告诉我哪些单元格用了公式。`
- Session:
  - `sessionKey=agent:main:codex-smoke-e01-1783593800`
  - `sessionId=acc882fd-a163-4181-bfa1-bd50875e5b0f`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/月度预算_20260709_184002.xlsx`
- UClaw actual:
  - Created a real `.xlsx` file with a `月度预算` sheet and a `公式说明` sheet.
  - Generated 30 formula cells and 2 charts.
  - The run verified formulas and chart count via `openpyxl` before final reply.
  - Final reply listed formula ranges/cells and included the `MEDIA:` path.
  - Runtime was about `71.8s`.
- Current judgment:
  - Artifact: pass.
  - Formula/chart validation: pass.
  - Quality: pass for this prompt.
  - Performance gap: slow for a local Excel artifact; much of the time is agent/model/tool-loop overhead, not workbook writing.

#### F03 / Activity Signup Page With Detected Bug But No Repair

- Prompt: `做一个活动报名页面，包含表单校验和报名成功状态，单文件 HTML，必须保存成真实本地文件，做完后自己检查主要交互。`
- Session:
  - `sessionKey=agent:main:codex-smoke-f03-1783593800`
  - `sessionId=874c9dea-4c67-45d4-8f79-023763cccaf5`
- Artifact:
  - `/Users/huajing002/.openclaw/workspace/活动报名页面.html`
- UClaw actual:
  - Created a real HTML file of about `16KB`.
  - Opened the page in browser validation.
  - Browser snapshot showed the `报名成功` state visible on first load.
  - The agent correctly diagnosed the issue: `.success-state { display: grid }` overrides the HTML `hidden` attribute.
  - Final assistant reply said: `我先修掉再继续测。`
  - The run then ended without repairing the file or continuing validation.
  - Local inspection confirms the file still contains `.success-state { display: grid ... }` and lacks a CSS rule such as `[hidden]{display:none!important}`.
- Current judgment:
  - Artifact existence: pass.
  - Self-check detection: pass.
  - Delivery/gate: fail. It should not end with a promise to fix after detecting a blocker.
  - User experience: fail. Codex-style behavior would repair the file, re-run the interaction check, then deliver one final result.
- Required implementation:
  - Completion gate must treat "I will fix / I will continue" as unfinished when a validator has found a blocking artifact bug.
  - Web artifact validator should encode hidden-state checks for common success/error panels.
  - Local HTML writer should include a safe base rule for `[hidden]`.

#### C02 / Composite Coffee-Shop Opening Pack

- Prompt: `给我做一套“咖啡店开业”的素材包：菜单表格、开业宣传文案、小程序页面、短视频脚本。每个事儿都随便来一个，能直接做就直接做，必须保存真实本地文件。`
- Session:
  - `sessionKey=agent:main:codex-smoke-c02-1783593800`
  - `sessionId=1050ba36-ac26-4a04-9557-ad0619cf9b8d`
- Artifact directory:
  - `/Users/huajing002/.openclaw/workspace/咖啡店开业素材包_20260709_1838`
- Final artifacts:
  - `咖啡店开业菜单表格.xlsx`
  - `咖啡店开业宣传文案.md`
  - `咖啡店开业小程序页面.html`
  - `咖啡店开业短视频脚本.md`
- UClaw actual:
  - Produced the requested four deliverables and a compact final manifest with `MEDIA:` paths.
  - Verified files using `ls` and `file`.
  - The first `create_html_app_file` result for the mini-program page was only `202` bytes and contained an empty `<body>`.
  - The agent detected this by reading the file, repaired it via `write`, then verified the repaired file was about `4KB`.
  - Runtime was about `118s`.
- Current judgment:
  - Composite intent: pass for this constrained non-media pack.
  - Artifact delivery: pass after repair.
  - Product quality: partial pass.
  - Writer/validator gap: same as F01/C01, the low-level HTML writer can report success for an unusable shell. The agent can recover, but this should be caught before final success and without noisy detours.
  - Performance gap: high for a local four-file pack.

#### F02 / Artifact Manifest Fallback After Terminal Model Error

- Evidence type: `uclaw-code-evidence`
- Change:
  - `src/stores/chat.ts` now detects a terminal assistant error after the same user turn already produced assistant artifact attachments or artifact paths.
  - In that case the UI appends a local assistant fallback with the delivered artifact list and clears `runError` instead of showing only the final model failure.
  - The terminal assistant error bubble is removed from that latest turn only when artifact fallback is available.
- Regression:
  - `tests/unit/chat-target-routing.test.ts` covers `MEDIA:/tmp/uclaw-budget.xlsx` + `MEDIA:/tmp/uclaw-plan.pptx` followed by `[assistant turn failed] HTTP 429`.
  - Result: user-facing last message becomes a deliverable artifact manifest with both files attached; `runError` is `null`.
- Verification:
  - `pnpm exec vitest run tests/unit/chat-target-routing.test.ts` passed.
  - `pnpm exec vitest run tests/unit/media-intent-planner.test.ts` passed.
  - Vite transform check for `/src/stores/chat.ts` returned HTTP 200.
- Remaining:
  - Needs Electron visual retest with a real final-LLM failure or mocked transcript reload.

## Current Remaining P0 Gaps After This Batch

- Electron visual confirmation is still required for:
  - ordinary chat graph hidden by default;
  - C01 compact progress/result layout;
  - G01 reload showing the unified manifest instead of split old rows;
  - media timing displayed as compact user-facing elapsed time.
- Execution/runtime gaps still open:
  - external-data web demo artifact intent and gate normalization (`X01`);
  - async video failure completion propagation to all UI/test waiters (`B05`);
  - HTML writer/validator should reject empty shell output before final delivery (`F01`);
  - final delivery should survive a final-model 429 when artifacts already exist (`F02`) - code-side fallback added, Electron visual retest pending;
  - promise-only repair text should not pass completion gate (`D01`);
  - promise-only repair text should not end a web artifact run after a detected validation bug (`F03`);
  - single artifact prompts should not be misclassified as composite multi-task runs (`D01`);
  - follow-up vision should produce exactly one final reply, not truncated/duplicated assistant rows (`G02`);
  - async media completion should attach to the owning run as artifact events, not persisted internal/inter-session pseudo-user messages (`H01/H02`);
  - composite run ownership should collapse one prompt into one visible result (`C01/G01`);
  - video model/config question should answer from product config, not raw tool provider defaults (`L03`).
- Local artifact runtime gaps:
  - HTML writer/validator can report success for empty or broken pages and relies on agent repair (`F01`, `C02`);
  - web artifact validation should catch common UI-state problems such as `[hidden]` being overridden by display rules (`F03`);
- Performance gaps:
  - local Excel/web/composite artifacts take tens of seconds to minutes due to model/tool-loop overhead even when file writing itself is cheap (`E01`, `C02`);
- P1/P2 product gaps:
  - preference/memory updates should avoid a long visible execution loop when the intended result is a short confirmation (`L04`);
