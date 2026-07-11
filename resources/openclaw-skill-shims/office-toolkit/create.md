# Office create compatibility entry

This file keeps older agents and cached instructions that request
`office-toolkit/create.md` on the supported path. The canonical instructions
remain in [`references/create.md`](references/create.md).

For a PPT or PPTX creation request, use the bundled `presentation-maker` skill
and prefer `create_designed_pptx_file`. It renders a model-authored free canvas
with local images, charts, tables, and per-slide composition, then returns a
`MEDIA:<absolute-path>` result. Do not finish after generating only supporting
images, an outline, or Markdown.

Use `create_pptx_file` only as the lightweight fallback if the designed tool is
unavailable. For DOCX and XLSX creation details, read `references/create.md`
now.
