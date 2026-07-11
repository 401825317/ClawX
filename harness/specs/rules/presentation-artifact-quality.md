---
id: presentation-artifact-quality
title: Presentation Artifact Quality
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
---

Presentation generation must treat the PPTX writer as a free-canvas rendering engine, not as a visible template.

- A standalone presentation request routes to the ordinary OpenClaw agent, the bundled `presentation-maker` skill, and `create_designed_pptx_file`. Main-process deterministic rendering must not intercept this path.
- Presentation copy such as `多用图片` plus `生成可编辑的 PPTX` describes deck content and editability. It must never trigger `image_edit` or an upload-image clarification before the presentation skill runs.
- The agent plans a prompt-specific story, visual direction, and per-slide composition before rendering. It sources or generates real visual assets when the subject benefits from them.
- The studio contract supports positioned text, local images, shapes, charts, and tables on a 0-100 canvas. It must not reduce every page to title, subtitle, and repeated bullet cards.
- Five-page-or-longer decks require evidence visuals on at least 40 percent of content slides and at least three distinct layout signatures. Evidence visuals include images, charts, tables, and genuinely data-led large-number compositions; small labels, step numbers, and ordinary body copy do not qualify. Text collisions, canvas overflow, severely unreadable text/background contrast, empty pages, placeholder copy, and page-count drift block completion.
- Product, place, person, and object decks show the actual subject when suitable assets are available. The same decorative image must not be reused across the whole deck.
- `create_pptx_file`, semantic theme families, and the bundled XML generator remain basic fallbacks only. A fallback result is disclosed as such and cannot be reported as a high-design deck.
- Cross-topic validation compares at least one product deck with one travel deck and confirms different visual assets, composition signatures, successful Office openability, readable renders, and no incoherent overlap.
