import { readFile } from 'node:fs/promises';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';

async function openSettings(app: Parameters<typeof getStableWindow>[0]) {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await page.getByTestId('sidebar-nav-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('settings-long-term-rules')).toBeVisible();
  return page;
}

test.describe('long-term rules', () => {
  test('persists, projects, edits, disables, deletes, and undoes an Agent rule', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, managedProvider: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
        managedClientConfig: {
          features: {
            longTermRules: { enabled: true },
          },
        },
      });
      const gateStatus = await app.evaluate(async ({ app: _app }, workspaceRoot) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const handler = (ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, request: unknown) => Promise<unknown>>;
        })._invokeHandlers?.get('host:invoke');
        if (!handler) throw new Error('Long-term rules E2E could not find host:invoke');
        return handler({}, {
          id: 'e2e-long-term-rules-gate-check',
          module: 'longTermRules',
          action: 'list',
          payload: { agentId: 'main', workspaceRoot },
        });
      }, fixture.workspaceDir);
      expect(gateStatus).toMatchObject({ ok: true, data: { status: 'enabled' } });
      await fixture.createWorkspaceFile('AGENTS.md', '# User-owned instructions\n\nKeep this paragraph.\n');
      const page = await openSettings(app);
      await expect.poll(async () => {
        for (const testId of [
          'long-term-rule-new-content',
          'long-term-rules-disabled',
          'long-term-rules-error',
          'long-term-rules-loading',
        ]) {
          if (await page.getByTestId(testId).isVisible()) return testId;
        }
        return 'none';
      }, { timeout: 5_000 }).toBe('long-term-rule-new-content');
      const initialContent = 'Always keep generated documents concise.';
      const editedContent = 'Always keep generated documents concise and verify the output.';

      await page.getByTestId('long-term-rule-new-content').fill(initialContent);
      await page.getByTestId('long-term-rule-scope-agent').click();
      await page.getByTestId('long-term-rule-create').click();
      const initialRule = page.locator('article[data-testid^="long-term-rule-"]').filter({ hasText: initialContent }).first();
      await expect(initialRule).toBeVisible();
      const ruleTestId = await initialRule.getAttribute('data-testid');
      expect(ruleTestId).toMatch(/^long-term-rule-[0-9a-f-]+$/u);
      const ruleId = ruleTestId!.replace('long-term-rule-', '');
      const rule = page.getByTestId(`long-term-rule-${ruleId}`);

      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(
        '<!-- UCLAW_LONG_TERM_RULES_START -->',
      );
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(initialContent);
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(
        'Keep this paragraph.',
      );

      await rule.getByRole('button', { name: 'Edit rule' }).click();
      const editor = page.getByTestId(`long-term-rule-edit-${ruleId}`);
      await editor.fill(editedContent);
      await rule.getByRole('button', { name: 'Save rule' }).click();
      await expect(page.getByText(editedContent, { exact: true })).toBeVisible();
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(editedContent);

      const toggle = rule.getByRole('switch');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).not.toContain(
        editedContent,
      );
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(editedContent);

      await rule.getByRole('button', { name: 'Delete rule' }).click();
      await expect(rule).toHaveCount(0);
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).not.toContain(
        editedContent,
      );
      const undo = page.getByRole('button', { name: 'Undo' });
      await expect(undo).toBeVisible();
      await undo.click();
      await expect(page.getByText(editedContent, { exact: true })).toBeVisible();
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(editedContent);
      await expect.poll(async () => readFile(`${fixture.workspaceDir}/AGENTS.md`, 'utf8')).toContain(
        'Keep this paragraph.',
      );
    } finally {
      await closeElectronApp(app);
    }
  });
});
