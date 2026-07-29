# ACP Tool Group Shimmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved B-style text shimmer to the active trailing ACP tool group and stop it only when a content boundary or terminal turn state closes the tool phase.

**Architecture:** Derive active state with a pure helper from the group position, tool replay flags/statuses, and existing `AcpTurnTiming`. Pass one `active` boolean through `AcpAssistantTurn` to `AcpToolCallGroup`; render the shimmer with CSS only, without Store state, timers, Gateway subscriptions, or OpenClaw changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, global CSS keyframes, Vitest, Testing Library, Electron Playwright.

**Repository constraint:** Work in the current `feature/claw-0.5.1` workspace. Do not commit, push or create a PR unless the user explicitly requests it.

---

### Task 1: Derive active tool-phase state

**Files:**
- Modify: `src/lib/acp/tool-call-groups.ts`
- Modify: `tests/unit/acp-tool-call-groups.test.ts`

- [ ] **Step 1: Write failing active-state tests**

Add tests for this intended API:

```ts
expect(isToolCallGroupActive({
  items: [completedLiveTool],
  isLastEntry: true,
  timing: { source: 'live', status: 'running', startedAtMs: 1 },
})).toBe(true);
```

Cover: trailing live timing bridges terminal tool gaps; a non-trailing group is inactive; complete timing overrides stale running tools; missing timing falls back to a non-historical `pending/running` tool; historical-only groups are inactive.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/acp-tool-call-groups.test.ts
```

Expected: FAIL because `isToolCallGroupActive` does not exist.

- [ ] **Step 3: Implement the pure helper**

Add this exported function without adding component or Store state:

```ts
export function isToolCallGroupActive(input: {
  items: ToolCallItem[];
  isLastEntry: boolean;
  timing?: AcpTurnTiming;
}): boolean {
  if (!input.isLastEntry || input.timing?.status === 'complete') return false;
  if (input.timing?.status === 'running') return true;
  return input.items.some((item) => (
    !item.historical && (item.status === 'pending' || item.status === 'running')
  ));
}
```

- [ ] **Step 4: Verify GREEN**

Run the Task 1 Vitest command. Expected: all projection and active-state tests PASS.

### Task 2: Render the approved B-style shimmer

**Files:**
- Modify: `src/pages/Chat/AcpAssistantTurn.tsx`
- Modify: `src/pages/Chat/AcpToolCallGroup.tsx`
- Modify: `src/styles/globals.css`
- Modify: `tests/unit/acp-chat-components.test.tsx`

- [ ] **Step 1: Write failing component tests**

Extend the tool-group tests to assert:

```tsx
render(<AcpToolCallGroup id="tool-call-group:tool:a" items={[toolA, toolB]} active />);
expect(screen.getByTestId('acp-tool-call-group')).toHaveAttribute('data-active', 'true');
expect(screen.getByTestId('acp-tool-group-summary')).toHaveClass('acp-tool-group-shimmer');
expect(screen.getByTestId('acp-tool-group-toggle')).toHaveTextContent('Running');
```

Rerender with `active={false}` and assert the shimmer class is absent, the check icon is present, and the completed copy is shown. Render a timeline with two separated groups plus live timing and assert only the final display group is active.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/acp-chat-components.test.tsx
```

Expected: FAIL because the group has no `active` prop or shimmer class.

- [ ] **Step 3: Pass derived activity from the render boundary**

Use the display-entry index in `AcpAssistantTurn`:

```tsx
{displayEntries.map((entry, index) => {
  if (entry.kind === 'tool-call-group') {
    const active = isToolCallGroupActive({
      items: entry.items,
      isLastEntry: index === displayEntries.length - 1,
      timing,
    });
    return <AcpToolCallGroup id={entry.id} items={entry.items} active={active} />;
  }
  // Existing non-group branches remain unchanged.
})}
```

- [ ] **Step 4: Render active and completed states without layout changes**

Change `AcpToolCallGroup` to accept required `active: boolean`. Use it for the neutral running/completed summary and icon, add `data-active`, and apply `acp-tool-group-shimmer` only to the summary text. Keep default group folding and failure-neutral behavior unchanged.

- [ ] **Step 5: Add the shimmer keyframes and reduced-motion fallback**

Append a focused class to `src/styles/globals.css`:

```css
@keyframes acp-tool-group-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.acp-tool-group-shimmer {
  color: transparent;
  background-image: linear-gradient(
    90deg,
    hsl(var(--muted-foreground)) 20%,
    hsl(var(--foreground)) 45%,
    hsl(var(--muted-foreground)) 70%
  );
  background-size: 220% 100%;
  background-clip: text;
  animation: acp-tool-group-shimmer 1.8s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .acp-tool-group-shimmer { animation: none; }
}
```

Also add `motion-reduce:animate-none` to the running spinner. Do not animate the row background, Chevron or item count.

- [ ] **Step 6: Verify GREEN**

Run both focused unit files. Expected: all tests PASS and existing standalone tool-card behavior remains unchanged.

### Task 3: Add Electron regression coverage and verify

**Files:**
- Modify: `tests/e2e/chat-acp-inline-timeline.spec.ts`

- [ ] **Step 1: Extend the existing grouped-tools scenario**

Install the existing deferred ACP prompt mock, send one prompt through the composer to create a live turn timing, and emit a completed two-tool trailing group. Assert `data-active="true"` and the shimmer class. Append an assistant text chunk and assert the prior group changes to `data-active="false"`; emit a second completed two-tool trailing group, resolve the deferred prompt, and assert no tool-group summary retains the shimmer class.

- [ ] **Step 2: Build the current Renderer**

Run:

```bash
pnpm run build:vite
```

Expected: exit 0; existing chunk-size warnings are allowed.

- [ ] **Step 3: Run the Electron scenario**

Run:

```bash
pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts --grep "groups consecutive ACP tool calls"
```

Expected: one test PASS at normal and narrow widths with no text/count overlap.

- [ ] **Step 4: Run final static verification**

```bash
pnpm exec vitest run tests/unit/acp-tool-call-groups.test.ts tests/unit/acp-chat-components.test.tsx
pnpm run typecheck:web
pnpm run typecheck:node
git diff --check
```

Expected: all commands exit 0. Audit the diff to confirm no changes under ACP reducer, Store, Gateway, OpenClaw or history projection.
