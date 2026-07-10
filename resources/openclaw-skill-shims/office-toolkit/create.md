# Office create compatibility entry

This file keeps older agents and cached instructions that request
`office-toolkit/create.md` on the supported path. The canonical instructions
remain in [`references/create.md`](references/create.md).

For a PPT or PPTX creation request, prefer the built-in
`create_pptx_file` tool when it is available. It creates a real local PPTX
without Python setup and returns a `MEDIA:<absolute-path>` result. Do not finish
after generating only supporting images, an outline, or Markdown.

If `create_pptx_file` is unavailable, use the bundled `presentation-maker`
skill before falling back to Python. For DOCX and XLSX creation details, read
`references/create.md` now.
