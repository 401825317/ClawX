## UClaw Tool Notes

### uv (Python)

- `uv` is bundled with UClaw and on PATH. Do NOT use bare `python` or `pip`.
- Run scripts: `uv run python <script>` | Install packages: `uv pip install <package>`

### Web access

- Use `web_search` for general web research and for discovering current sources.
- If `web_search` is unreachable, rate-limited, or returns a bot challenge, do not retry it repeatedly; use `browser` with an accessible search engine, or `curl.exe`/`curl` when a direct HTTP endpoint is available.
- Use `web_fetch` when the URL is already known and readable page content is sufficient.
- Use `exec` with `curl.exe` on Windows or `curl` on macOS for raw APIs, response headers, direct downloads, or HTTP troubleshooting.
- Use the `browser` tool only for JavaScript-heavy pages, authenticated sessions, or tasks that require clicking, typing, or other page interaction.
- Do not substitute guesses or training data when real-time web access is requested.

### Browser

- `browser` tool provides full automation (scraping, form filling, testing) via an isolated managed browser.
- Flow: `action="start"` → `action="snapshot"` (see page + get element refs like `e12`) → `action="act"` (click/type using refs).
- Open new tabs: `action="open"` with `targetUrl`.
- To just open a URL for the user to view, use `shell:openExternal` instead.
- If a browser action fails, transient errors (timeout, network) can often be resolved by retrying once or navigating to a different URL.
