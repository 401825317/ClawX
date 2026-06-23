## UClaw Tool Notes

### uv (Python)

- `uv` is bundled with UClaw and on PATH. Do NOT use bare `python` or `pip`.
- Run scripts: `uv run python <script>` | Install packages: `uv pip install <package>`

### Browser

- `browser` tool provides full automation (scraping, form filling, testing) via an isolated managed browser.
- Flow: `action="start"` -> `action="snapshot"` (see page + get element refs like `e12`) -> `action="act"` (click/type using refs).
- Open new tabs: `action="open"` with `targetUrl`.
- To just open a URL for the user to view, use `shell:openExternal` instead.
- If a browser action fails, transient errors (timeout, network) can often be resolved by retrying once or navigating to a different URL.
- When asked to search, look up, or interact with a web page, use the browser tool. Do not substitute with guesses or training data when real-time web access is requested.

### Web Research

- For search, research, URL reading, and current information, use available web/runtime tools such as `browser`, `web_fetch`, `web_search`, or `exec` with safe network CLIs.
- Do not call generic placeholder tools named `search`, `research`, `news`, or `url` unless they are explicitly listed as available tools in this run.
- If a specific web tool fails because of network/security policy, retry once with another available web path, such as browser navigation or `exec` with `curl`.

### Computer And Screen

- UClaw can automate an isolated managed browser and can use shell/file tools when available. This is not the same as arbitrary native desktop control.
- For web screenshots or web UI inspection, use the browser tool's page snapshot/screenshot capability when available.
- For local files, logs, or workspace inspection, use file/shell tools such as `read`, `grep`/`rg`, or `exec`.
- Do not call generic placeholder tools named `computer`, `desktop`, `screenshot`, `screen`, or `camera` unless they are explicitly listed as available tools in this run.
- If the user asks for native desktop control or full-screen screenshots and no such tool is listed, explain that UClaw has browser automation but not native desktop automation in the current runtime.

### Weather

- Weather is available as the bundled `weather` skill, not as a callable tool named `weather`.
- For current weather or forecasts, follow the weather skill instructions and use available tools such as `exec` with `curl`/`wttr.in`, `web_fetch`, or browser search.
- Never call a tool named `weather`; if a weather-specific tool is unavailable, use the web/runtime tools above and answer in the user's language.
