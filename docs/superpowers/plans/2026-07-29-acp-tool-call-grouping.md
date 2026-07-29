# ACP Tool Call Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive ACP tool calls into one compact, manually expandable renderer group without changing event order or runtime state.

**Architecture:** Add a pure renderer projection over `AcpAssistantTurnDisplayGroup.items`, then render multi-tool runs through a dedicated group component. Keep ACP reducer, Store, Gateway, OpenClaw, attachments and single-tool behavior unchanged.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, react-i18next, Lucide, Vitest, Testing Library, Electron Playwright.

**Repository constraint:** Work in the current `feature/claw-0.5.1` workspace. Do not commit, push or create a PR unless the user explicitly requests it.

---

### Task 1: Add the pure consecutive-tool projection

**Files:**
- Create: `src/lib/acp/tool-call-groups.ts`
- Create: `tests/unit/acp-tool-call-groups.test.ts`

- [ ] **Step 1: Write failing grouping tests**

Cover a two-tool run, a singleton, non-tool boundaries, two separate groups and a stable ID after appending another tool. Use this intended API:

```ts
const entries = groupConsecutiveToolCalls(items);
expect(entries).toEqual([
  { kind: 'tool-call-group', id: 'tool-call-group:tool:a', items: [toolA, toolB] },
]);
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/acp-tool-call-groups.test.ts
```

Expected: FAIL because `@/lib/acp/tool-call-groups` does not exist.

- [ ] **Step 3: Implement the minimal O(n) projection**

Create these exported types and function:

```ts
import type { TimelineItem, ToolCallItem } from './timeline-types';

export type AcpAssistantDisplayEntry =
  | { kind: 'timeline-item'; item: TimelineItem }
  | { kind: 'tool-call-group'; id: string; items: ToolCallItem[] };

export function groupConsecutiveToolCalls(items: TimelineItem[]): AcpAssistantDisplayEntry[] {
  const entries: AcpAssistantDisplayEntry[] = [];
  let tools: ToolCallItem[] = [];
  const flush = () => {
    if (tools.length === 1) entries.push({ kind: 'timeline-item', item: tools[0] });
    if (tools.length > 1) entries.push({ kind: 'tool-call-group', id: `tool-call-group:${tools[0].id}`, items: tools });
    tools = [];
  };
  for (const item of items) {
    if (item.kind === 'tool-call') tools.push(item);
    else {
      flush();
      entries.push({ kind: 'timeline-item', item });
    }
  }
  flush();
  return entries;
}
```

- [ ] **Step 4: Verify GREEN**

Run the Task 1 Vitest command. Expected: all grouping tests PASS.

### Task 2: Add the compact tool-group component

**Files:**
- Create: `src/pages/Chat/AcpToolCallGroup.tsx`
- Modify: `src/pages/Chat/AcpToolCallCard.tsx`
- Modify: `shared/i18n/locales/en/chat.json`
- Modify: `shared/i18n/locales/zh/chat.json`
- Modify: `shared/i18n/locales/ja/chat.json`
- Modify: `shared/i18n/locales/ru/chat.json`
- Modify: `tests/unit/acp-chat-components.test.tsx`

- [ ] **Step 1: Write failing component tests**

Add translations to the existing `react-i18next` test mock and assert:

```tsx
render(<AcpToolCallGroup id="tool-call-group:tool:a" items={[readTool, failedExecTool]} />);
const group = screen.getByTestId('acp-tool-call-group');
expect(group).toHaveAttribute('data-expanded', 'false');
expect(group).not.toHaveTextContent(/failed|失败/i);
expect(screen.queryByText(readTool.title)).not.toBeVisible();
fireEvent.click(screen.getByTestId('acp-tool-group-toggle'));
expect(group).toHaveAttribute('data-expanded', 'true');
expect(screen.getAllByTestId('acp-tool-call-card')).toHaveLength(2);
```

Also rerender with a third item and assert the manually expanded group remains expanded.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run tests/unit/acp-chat-components.test.tsx
```

Expected: FAIL because `AcpToolCallGroup` and grouped card rendering do not exist.

- [ ] **Step 3: Add grouped card rendering**

Extend `AcpToolCallCard` with a narrow prop:

```ts
type AcpToolCallCardProps = {
  item: ToolCallItem;
  variant?: 'standalone' | 'grouped';
};
```

For `variant="grouped"`, initialize detail expansion to false, skip automatic expansion/collapse, remove the repeated “Tool” label, and map every terminal item to a neutral completed status at row level. Preserve the existing standalone branch exactly.

- [ ] **Step 4: Implement group summary and manual expansion**

`AcpToolCallGroup` must:

```tsx
const [expanded, setExpanded] = useState(false);
const running = items.some((item) => item.status === 'pending' || item.status === 'running');
```

Use a stable `button` with `aria-expanded`, `aria-controls`, `data-testid="acp-tool-group-toggle"`, and render children only while expanded. Identify categories from ACP `toolKind`; use `Intl.ListFormat(i18n.language)` for at most two prioritized activity phrases, ignore unknown kinds when known activities exist, and fall back to a neutral operation phrase only when no activity can be identified. Do not inspect `item.error`, expose call counts, or count `failed` items when building the group summary.

- [ ] **Step 5: Add all locale strings**

Under `chat.acp.toolGroup`, add localized equivalents for:

```json
{
  "expand": "Expand tool calls",
  "collapse": "Collapse tool calls",
  "runningGeneric": "Working on related operations",
  "completedGeneric": "Completed related operations",
  "runningRead": "Reading files",
  "completedRead": "Read files",
  "runningEdit": "Editing files",
  "completedEdit": "Edited files",
  "runningSearch": "Researching information",
  "completedSearch": "Researched information",
  "runningExecute": "Running commands",
  "completedExecute": "Ran multiple commands",
  "runningFetch": "Researching information",
  "completedFetch": "Researched information"
}
```

Provide natural Chinese, Japanese and Russian translations rather than copying English.

- [ ] **Step 6: Verify GREEN**

Run the Task 2 Vitest command. Expected: existing single-card tests and new group tests PASS.

### Task 3: Integrate grouping at the assistant-turn render boundary

**Files:**
- Modify: `src/pages/Chat/AcpAssistantTurn.tsx`
- Modify: `tests/unit/acp-chat-components.test.tsx`

- [ ] **Step 1: Write failing integration tests**

Render an `AcpTimeline` containing:

```text
assistant text -> tool A -> tool B -> thought -> tool C -> tool D -> assistant text
```

Assert two group toggles exist, item order remains unchanged through `data-acp-item-id`, and no individual tool title is visible before expansion.

- [ ] **Step 2: Verify RED**

Run the Task 2 Vitest command. Expected: FAIL because `AcpAssistantTurn` still renders each tool independently.

- [ ] **Step 3: Integrate the projection with `useMemo`**

In `AcpAssistantTurn`:

```tsx
const displayEntries = useMemo(() => groupConsecutiveToolCalls(group.items), [group.items]);
```

Render `tool-call-group` entries through `AcpToolCallGroup`; for `timeline-item`, retain the existing message, permission, thought, plan and single-tool branches. Put each grouped tool ID on its expanded row so diagnostics and tests can still locate the original ACP item.

- [ ] **Step 4: Verify GREEN**

Run both unit files:

```bash
pnpm exec vitest run tests/unit/acp-tool-call-groups.test.ts tests/unit/acp-chat-components.test.tsx
```

Expected: PASS with all existing single-tool behavior preserved.

### Task 4: Add packaged UI regression coverage

**Files:**
- Modify: `tests/e2e/chat-acp-inline-timeline.spec.ts`

- [ ] **Step 1: Write the Electron E2E scenario**

Emit live ACP updates in this order:

```text
agent_message_chunk -> read tool -> execute tool -> agent_message_chunk -> search tool -> read tool
```

Assert there are two collapsed `acp-tool-call-group` elements, their summaries do not contain `Failed`, the first click reveals exactly its two original tool cards in order, and the second group remains collapsed.

- [ ] **Step 2: Verify the scenario fails before integration is complete**

Run:

```bash
pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts --grep "groups consecutive ACP tool calls"
```

Expected before Tasks 1-3: FAIL because no tool-group element exists. If Tasks 1-3 are already green, preserve the earlier unit RED evidence and require this E2E to pass before completion.

- [ ] **Step 3: Verify the Electron scenario passes**

Run the same Playwright command. Expected: one test PASS.

### Task 5: Final verification and scope audit

**Files:**
- Review: `README.md`
- Review: `README.zh-CN.md`
- Review: `README.ja-JP.md`
- Review: all files changed in Tasks 1-4

- [ ] **Step 1: Run focused and static verification**

```bash
pnpm exec vitest run tests/unit/acp-tool-call-groups.test.ts tests/unit/acp-chat-components.test.tsx
pnpm run typecheck:web
pnpm run typecheck:node
pnpm run build:vite
git diff --check
```

Expected: all commands exit 0. Existing Vite chunk-size warnings may remain; no new warnings should reference tool grouping.

- [ ] **Step 2: Inspect the rendered application**

Start `pnpm dev`, open a controlled ACP session, and verify desktop plus a narrow viewport: summaries truncate cleanly, keyboard toggle works, both themes remain legible, and stream appends do not jump or reopen groups.

- [ ] **Step 3: Audit scope**

Confirm no changes to ACP reducer, Store, Gateway, OpenClaw, media generation, attachment ownership or history refresh. Review README files; this renderer-only presentation change does not require user setup documentation unless existing screenshots describe per-tool layout.

- [ ] **Step 4: Preserve the working tree**

Report changed files and verification results. Do not commit, push, merge or delete unrelated user changes.
