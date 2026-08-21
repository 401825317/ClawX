import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';
import {
  executeInWebBrowserGuest,
  getWebBrowserMainSnapshot,
} from './fixtures/web-browser';

const MAIN_SESSION_KEY = 'agent:main:main';
const TOKENIZED_LOOPBACK_PREVIEW_URL = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/index\.html$/u;

type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string };

function webpageUpdate(toolCallId: string, filePath: string): AcpSessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    title: 'Create HTML',
    status: 'completed',
    rawOutput: { ok: true, kind: 'webpage', filePath },
  };
}

async function openChat(app: Parameters<typeof getStableWindow>[0]) {
  const page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  return page;
}

function callsFor(fixture: Awaited<ReturnType<typeof installAttachmentHostFixture>>, action: string) {
  return fixture.getHostInvocations().then((calls) => calls.filter((call) => (
    call.module === (action === 'navigate' ? 'webBrowser' : 'artifactTasks')
    && call.action === (action === 'navigate' ? 'navigate' : 'validateWebpage')
  )));
}

test.describe('HTML artifact automatic preview', () => {
  test('ignores history, validates live paths in Main, refreshes updates, and rejects outside files', async ({
    launchElectronApp,
  }) => {
    test.skip(process.platform !== 'win32' && process.platform !== 'darwin');
    const app = await launchElectronApp({ skipSetup: true, managedProvider: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        replayInLoadResult: true,
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
        managedClientConfig: {
          features: {
            htmlPreview: { enabled: true },
          },
        },
        useProductionHtmlPreview: true,
      });
      const firstPath = await fixture.createWorkspaceFile(
        'site/index.html',
        '<!doctype html><title>First</title><h1>First</h1>',
      );
      const secondPath = await fixture.createWorkspaceFile(
        'site/updated.html',
        '<!doctype html><title>Second</title><h1>Second</h1>',
      );
      const outsidePath = await fixture.createOutsideFile(
        'outside.html',
        '<!doctype html><title>Outside</title>',
      );

      await fixture.setSessionReplay(MAIN_SESSION_KEY, [webpageUpdate('historical-html', firstPath)]);
      await openChat(app);
      await expect.poll(() => callsFor(fixture, 'navigate')).toHaveLength(0);

      await fixture.clearInvocations();
      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [webpageUpdate('live-html', firstPath)],
      });
      await expect.poll(() => callsFor(fixture, 'navigate')).toHaveLength(1);
      await expect.poll(async () => {
        const calls = await callsFor(fixture, 'navigate');
        return calls[0]?.payload?.url;
      }).toMatch(TOKENIZED_LOOPBACK_PREVIEW_URL);
      await expect.poll(() => callsFor(fixture, 'validateWebpage')).toHaveLength(1);
      await expect.poll(() => getWebBrowserMainSnapshot(app)).toMatchObject({
        url: expect.stringMatching(TOKENIZED_LOOPBACK_PREVIEW_URL),
        title: 'First',
        matchingGuestCount: 1,
      });
      const firstGuest = await getWebBrowserMainSnapshot(app);
      await expect(executeInWebBrowserGuest<string>(
        app,
        firstGuest.guestId!,
        'document.querySelector("h1")?.textContent ?? ""',
      )).resolves.toBe('First');

      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [webpageUpdate('live-html-refresh', firstPath)],
      });
      await expect.poll(() => callsFor(fixture, 'navigate')).toHaveLength(2);

      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [
          webpageUpdate('multi-html-first', firstPath),
          webpageUpdate('multi-html-last', secondPath),
        ],
      });
      await expect.poll(async () => {
        const calls = await callsFor(fixture, 'navigate');
        return calls.at(-1)?.payload?.url;
      }).toMatch(TOKENIZED_LOOPBACK_PREVIEW_URL);

      const navigateCountBeforeOutside = (await callsFor(fixture, 'navigate')).length;
      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [webpageUpdate('outside-html', outsidePath)],
      });
      await expect.poll(async () => (await callsFor(fixture, 'navigate')).length, {
        timeout: 1_000,
        intervals: [100, 200, 300],
      }).toBe(navigateCountBeforeOutside);

      const rejectedPath = `${firstPath}.missing.html`;
      const rejectedValidations = async () => (
        (await callsFor(fixture, 'validateWebpage'))
          .filter((call) => call.payload?.filePath === rejectedPath)
      );
      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [webpageUpdate('main-rejected-html', rejectedPath)],
      });
      await expect.poll(rejectedValidations).toHaveLength(1);
      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [webpageUpdate('main-rejected-html', rejectedPath)],
      });
      await expect.poll(rejectedValidations, {
        timeout: 1_000,
        intervals: [100, 200, 300],
      }).toHaveLength(1);
    } finally {
      await closeElectronApp(app);
    }
  });
});
