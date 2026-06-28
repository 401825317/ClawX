## UClaw Tool Notes

When explaining tool availability, missing tools, retries, or failures, use the user's language. Keep literal tool names and exact error strings unchanged.

### uv (Python)

- `uv` is bundled with UClaw and on PATH. Do NOT use bare `python` or `pip`.
- Run scripts: `uv run python <script>` | Install packages: `uv pip install <package>`
- On Windows/PowerShell, do not use Unix here-doc syntax such as `python - <<'PY'`; it fails with `重定向运算符后面缺少文件规范`. Use `uv run python -c "..."` for tiny scripts, or write/read a workspace script file when a multi-line script is genuinely necessary.

### Browser

- `browser` tool provides automation (scraping, form filling, testing) via an isolated managed browser when that tool is available and healthy.
- `browser` is not native desktop computer use. If the user explicitly asks for UClaw `computer use`, asks for `computer_browser_open_url`, asks to use the user's normal desktop browser, or asks to operate an existing Chrome/Edge window, do not read/use `browser-automation` and do not call `browser`; use the concrete `computer_*` tools instead.
- If you have already used any `computer_*` tool in the current task to operate the user's normal desktop, stay on the `computer_*` path for that task. Do not switch to `browser` for tab inspection or page control; normal Chrome usually has no DevToolsActivePort and `browser` may fail with `Could not connect to Chrome`.
- Flow: `action="start"` -> `action="snapshot"` (see page + get element refs like `e12`) -> `action="act"` (click/type using refs).
- Open new tabs: `action="open"` with `targetUrl`.
- Do not open local files with `file://` in the browser tool. If you need to preview a local HTML/Markdown/document artifact, use UClaw's file preview/workspace browser when available, or serve the workspace directory over `http://127.0.0.1:<port>/...` and open that HTTP URL.
- To just open a URL for the user to view, use `shell:openExternal` instead.
- If a browser action fails with a timeout, retry once with `action="status"` or `action="start"`. If it still fails, do not loop; use another available web path and explain the exact browser error in the user's language.
- When asked to interact with a page inside the local UClaw/Electron window, prefer the `computer_browser_dom_*` tools when they are listed.
- When asked to operate an already-open native Chrome/Edge/browser window, prefer the desktop computer-use tools (`computer_system_window_*`, `computer_uia_*`, `computer_mouse_*`, `computer_key_press`, `computer_type_text`) when they are listed.

### Web Research

- For search, research, URL reading, and current information, prefer `web_search` first when it is listed. Use `web_fetch` for known URLs or search-result pages. Use `browser` only when search/fetch cannot access the page or an interactive login/captcha/manual page view is required.
- Do not call generic placeholder tools named `search`, `research`, `news`, or `url` unless they are explicitly listed as available tools in this run.
- If `web_search` is disabled or no provider is available, say so briefly only if it affects the outcome, then fall back to `web_fetch` on search-engine/result URLs or browser navigation.
- Avoid shell/Python HTTP scraping for ordinary searches. Use `exec`, `uv`, `curl`, or ad-hoc Python network scripts only when the web tools are unavailable or insufficient, and keep errors out of the final answer unless they are necessary to explain a blocker.

### Computer And Screen

- UClaw has native computer-use tools when `computer_*` tools are listed. These include full-screen and window screenshots, clipboard read/write, Windows window listing/focus/move/resize/topmost, UI Automation tree/find, DOM inspection for UClaw windows, mouse movement/click/scroll/drag, keyboard shortcuts/text entry, display/cursor inspection, and file-dialog path entry.
- If the user explicitly mentions `computer use`, a `computer_*` tool, native desktop control, the user's normal browser, or an existing Chrome/Edge window, treat this section as higher priority than Browser/Web Research routing. Do not switch to `browser`, `browser-automation`, `exec`, PowerShell, or shell URL launching unless the requested `computer_*` tool is not listed or fails and no computer-use fallback exists.
- For full desktop screenshots or visual inspection, use `computer_screenshot` or `computer_inspect_screen`.
- For a specific application window screenshot, first use `computer_system_window_list` to identify the target window title/process. Use `computer_window_sources` only to obtain a `sourceId`; keep its default no-preview mode unless visual disambiguation is necessary, then call `computer_window_screenshot` with `sourceId` or `titleIncludes`.
- To open an http/https website in the user's normal browser, use `computer_browser_open_url` when it is listed. Prefer it over `browser`, `browser-automation`, `exec`, PowerShell, or shell browser launches.
- For native desktop apps and already-open Chrome/Edge windows, first identify the window with `computer_system_window_list`, bring it forward with `computer_system_window_control` or `computer_system_window_foreground`, inspect controls with `computer_uia_tree`/`computer_uia_find`, then act with mouse/keyboard tools.
- Before any app-specific global mouse/keyboard/text action, verify the target with `computer_system_window_foreground` and pass `expectedForeground` to `computer_mouse_move`, `computer_mouse_click`, `computer_mouse_button`, `computer_mouse_scroll`, `computer_mouse_drag`, `computer_key_press`, and `computer_type_text`. If focusing returns `success:false`, or the foreground window is not the intended target, stop and explain the focus problem; do not click, press keys, paste text, or manually type URLs into whatever window is active.
- For normal Chrome/Edge pages controlled through computer use, treat `computer_inspect_screen`, `computer_window_screenshot`, `computer_uia_find`, and `computer_uia_tree` as the primary inspection path. Screenshot files are visual context for the current chat model; do not call the standalone `image` tool just to inspect them when the current model can read images.
- If you must call the standalone `image` tool as a fallback, pass an explicit model that matches the current session's vision-capable model. For UClaw managed `lingzhiwuxian/smart-latest`, use `model: "openai/gpt-5.5"`. Never call `image` without an explicit model for computer-use screenshots, because OpenClaw's default image fallback may try unrelated providers such as Claude and add 403/timeout failures.
- Do not switch to `browser action="tabs"` or DevTools-based browser automation against the user's normal Chrome window.
- Do not use Ctrl+L plus typing to open websites unless `computer_browser_open_url` is unavailable and the browser window is confirmed foreground with `expectedForeground`.
- For web UI inside the UClaw/Electron window, prefer `computer_browser_dom_snapshot`, `computer_browser_dom_find`, and `computer_browser_dom_action`.
- For risky or mutating actions, call `computer_safety_evaluate` when useful and respect `requiresConfirmation` responses. Do not claim an action was completed when the host returned `requiresConfirmation`.
- For local files, logs, or workspace inspection, use file/shell tools such as `read`, `grep`/`rg`, or `exec`.
- Before reading a path you inferred, list the parent directory or check that the file exists. If `read` returns ENOENT, do not report it as a skill failure; explain in the user's language that the file is missing and inspect the actual directory contents.
- Do not call generic placeholder tools named `computer`, `desktop`, `screenshot`, `screen`, or `camera` unless they are explicitly listed as available tools in this run. Use the concrete `computer_*` tool names when available.
- If no `computer_*` tool is listed, explain in the user's language that native desktop computer-use tools are not available in the current runtime.

### Scheduled Tasks

- If you create a scheduled task from a non-default agent, do not target the shared `main` session.
- For non-default agents, use `sessionTarget: "isolated"` and `payload.kind: "agentTurn"`. Put the user-facing reminder/task text in the agent turn message.
- `sessionTarget: "main"` is only valid for the default agent. If cron rejects params with that rule, retry with isolated agent-turn delivery instead of telling the user the skill failed.

### Weather

- Weather is available as the bundled `weather` skill, not as a callable tool named `weather`.
- For current weather or forecasts, follow the weather skill instructions and prefer `web_search`, `web_fetch`, or browser search. Use `exec` with `curl`/`wttr.in` only as a last fallback when normal web tools are unavailable or insufficient.
- If the user asks for weather without naming a city, first use any trusted inbound location metadata if present. If no location metadata exists and `nodes` is listed, you may check connected nodes and request `location_get` only when an authorized node is available; if `nodes` returns an empty list, do not stop there.
- When no explicit city or node location is available, try IP-based weather lookup with `web_fetch` on `https://wttr.in/?format=j2` or a web search before asking the user for a city. If that produces only an approximate location, say it is approximate and continue with the weather/clothing answer.
- Ask the user for a city only after location metadata, connected node location, and IP/web fallback are unavailable or ambiguous.
- Never call a tool named `weather`; if a weather-specific tool is unavailable, use the web/runtime tools above and answer in the user's language.
