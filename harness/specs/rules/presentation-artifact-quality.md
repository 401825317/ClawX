---
id: presentation-artifact-quality
title: Presentation Artifact Quality
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
---

Presentation generation must treat the PPTX writer as a rendering engine, not as one visible template.

- Plans use a deterministic semantic design specification. Explicit theme choices win; otherwise the subject, audience, purpose, and tone select the theme family. Random recoloring is not a design decision.
- Product launches, travel stories, executive reports, training decks, and general editorial narratives must have visibly different cover composition, page chrome, palette, and content-layout behavior.
- The composite runtime, direct `create_pptx_file` tool, and bundled presentation fallback use the same theme-family vocabulary and first-slide-as-cover page-count contract.
- Structured layouts render their matching content fields without dropping columns, metrics, timelines, or statement content.
- Empty slides, placeholder copy, repeated content, missing theme markers, missing requested layouts, text overload, or page-count drift cannot pass completion verification.
- Cross-topic validation compares a product-launch deck with a travel-editorial deck and confirms different theme and slide XML signatures, successful Office openability, readable renders, and no incoherent overlap.
