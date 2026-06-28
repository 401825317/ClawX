---
name: browser-automation
description: Browser automation recovery loop for UClaw/OpenClaw managed browser tasks.
---

# Browser Automation

Use this skill only when the `browser` tool is listed and the task needs multi-step web automation.

## Routing

- Prefer the managed `openclaw` browser profile for ordinary browsing, research, and web workflows.
- Use `profile: "user"` only when the user's existing signed-in Chrome session is required.
- If `profile: "user"` fails with `DevToolsActivePort` or `Could not connect to Chrome`, stop retrying that profile and switch to available desktop `computer_*` tools or the managed `openclaw` browser profile.
- Do not use the `browser` tool for native desktop apps, file pickers, OS dialogs, QR/captcha/2FA blockers, or existing non-Chrome user browser windows. Use `computer_*` tools there.

## Loop

1. Start or status-check the browser profile.
2. Open or focus the intended page.
3. Take a snapshot before acting.
4. Act only on refs, labels, or current tab handles from the latest snapshot.
5. After click/type/navigation/evaluate, snapshot again before the next action.
6. If refs or target IDs become stale, refresh tabs/status/snapshot once and continue with the newest returned target ID.
7. If the page shows login, permission, captcha, QR code, 2FA, or an external app handoff, report the blocker or switch to desktop tools when available.

## Guardrails

- Do not read screenshots with Python/PIL just to get image size.
- Do not paste `javascript:` URLs into a browser address bar.
- Do not loop on the same browser error. Retry narrowly once, then change engine or report the real blocker.
- Do not expose recoverable intermediate browser errors as the final answer when later steps succeed.

