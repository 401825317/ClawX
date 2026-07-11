---
id: presentation-artifact-quality
title: Presentation Artifact Quality
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
---

Presentation generation must treat the PPTX writer as a free-canvas rendering engine, not as a visible template.

- A standalone presentation request routes to the ordinary OpenClaw agent, the bundled `presentation-maker` skill, and `create_designed_pptx_file`. Main-process deterministic rendering must not intercept this path.
- The agent plans a prompt-specific story, visual direction, and per-slide composition before rendering. It sources or generates real visual assets when the subject benefits from them.
- The studio contract supports positioned text, local images, shapes, charts, and tables on a 0-100 canvas. It must not reduce every page to title, subtitle, and repeated bullet cards.
- Five-page-or-longer decks require evidence visuals on at least 40 percent of content slides and at least three distinct layout signatures. Text collisions, canvas overflow, empty pages, placeholder copy, and page-count drift block completion.
- Product, place, person, and object decks show the actual subject when suitable assets are available. The same decorative image must not be reused across the whole deck.
- `create_pptx_file`, semantic theme families, and the bundled XML generator remain basic fallbacks only. A fallback result is disclosed as such and cannot be reported as a high-design deck.
- Cross-topic validation compares at least one product deck with one travel deck and confirms different visual assets, composition signatures, successful Office openability, readable renders, and no incoherent overlap.
