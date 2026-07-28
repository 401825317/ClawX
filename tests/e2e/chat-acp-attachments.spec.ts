import type { ElectronApplication, Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import {
  closeElectronApp,
  expect,
  getRecordedLegacyIpcInvocations,
  getStableWindow,
  installAttachmentHostFixture,
  test,
  type RecordedHostInvocation,
} from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';
const OTHER_SESSION_KEY = 'agent:main:other';
const PROMPT = 'Create the budget spreadsheet';
const REPLY = 'This is the budget_sample.xlsx file in the current directory.';

type AcpSessionUpdate = Record<string, unknown> & { sessionUpdate: string };

function workbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Category', 'Budget'],
    ['Operations', 1200],
  ]), 'Budget');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

function playableVideoBytes(): Uint8Array {
  return Buffer.from('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', 'base64');
}

function reportedFlowUpdates(): AcpSessionUpdate[] {
  return [{
    sessionUpdate: 'agent_message',
    messageId: 'budget-reply',
    content: [{ type: 'text', text: REPLY }],
  }];
}

function userUpdate(messageId: string, text: string): AcpSessionUpdate {
  return {
    sessionUpdate: 'user_message',
    messageId,
    content: [{ type: 'text', text }],
  };
}

function resourceUpdate(input: {
  messageId: string;
  uri: string;
  name: string;
  mimeType: string;
  text?: string;
}): AcpSessionUpdate {
  return {
    sessionUpdate: 'agent_message',
    messageId: input.messageId,
    content: [
      ...(input.text ? [{ type: 'text', text: input.text }] : []),
      {
        type: 'resource_link',
        uri: input.uri,
        name: input.name,
        mimeType: input.mimeType,
      },
    ],
  };
}

function filesActionCalls(
  calls: RecordedHostInvocation[],
  action: 'listAttachmentOpenHandlers' | 'openAttachmentWith' | 'revealAttachment',
): RecordedHostInvocation[] {
  return calls.filter((call) => call.module === 'files' && call.action === action);
}

async function openChat(app: ElectronApplication): Promise<Page> {
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

test.describe('ACP media attachments', () => {
  test('opens a local HTML attachment in the right-side Web Browser', async ({ launchElectronApp }) => {
    // Electron's webview support is unstable on Linux.
    test.skip(process.platform !== 'win32' && process.platform !== 'darwin');

    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const htmlPath = await fixture.createWorkspaceFile(
        'browser demo.html',
        '<!doctype html><title>Attachment Browser Demo</title><h1>Demo</h1>',
      );
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('html-browser-user', 'Show the HTML page'),
        resourceUpdate({
          messageId: 'html-browser-reply',
          uri: htmlPath,
          name: 'browser demo.html',
          mimeType: 'text/html',
          text: 'The HTML page is ready.',
        }),
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const trigger = page.getByRole('button', { name: 'Open browser demo.html with', exact: true });
      await expect(trigger).toBeEnabled({ timeout: 30_000 });
      await trigger.click();
      const browserItem = page.getByTestId('acp-file-open-in-built-in-browser');
      await expect(page.getByRole('menuitem').first()).toHaveAttribute(
        'data-testid',
        'acp-file-open-in-built-in-browser',
      );
      await browserItem.click();

      const expectedUrl = pathToFileURL(htmlPath).href;
      const panel = page.getByTestId('artifact-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('artifact-panel-tab-web-browser')).toHaveClass(/bg-foreground\/10/);
      await expect(page.getByTestId('web-browser-host')).toHaveAttribute('aria-hidden', 'false');
      await expect.poll(async () => (await fixture.getHostInvocations()).some((request) => (
        request.module === 'webBrowser'
        && request.action === 'navigate'
        && request.payload?.url === expectedUrl
      ))).toBe(true);
      await expect(page.getByTestId('web-browser-address-display')).toHaveAccessibleName(
        new RegExp(expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      await closeElectronApp(app);
    }
  });

  test('routes preview, open-with, and reveal through isolated typed host actions', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const spreadsheetPath = await fixture.createWorkspaceFile('open-with-budget.xlsx', workbookBytes());
      const nativeIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      await fixture.setOpenHandlersResult({
        ok: true,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        handlers: [
          { handlerId: 'app-alpha', name: 'Alpha Sheets', isDefault: false },
          { handlerId: 'app-default', name: 'Zulu Sheets', iconDataUrl: nativeIcon, isDefault: true },
        ],
      });
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('open-with-user', 'Show the open-with budget'),
        resourceUpdate({
          messageId: 'open-with-reply',
          uri: spreadsheetPath,
          name: 'Open with budget.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          text: 'The open-with budget is ready.',
        }),
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const preview = page.getByRole('button', { name: 'Preview Open with budget.xlsx', exact: true });
      const trigger = page.getByRole('button', { name: 'Open Open with budget.xlsx with', exact: true });
      await expect(preview).toBeEnabled({ timeout: 30_000 });
      await expect(trigger).toBeEnabled();
      await expect(trigger).toHaveCSS('align-self', 'auto');
      await expect(trigger).toHaveCSS('border-left-width', '0px');
      await expect.poll(async () => {
        const resolveCall = (await fixture.getHostInvocations()).find((call) => (
          call.module === 'files'
          && call.action === 'resolveAttachment'
          && (call.payload?.ref as Record<string, unknown> | undefined)?.uri === spreadsheetPath
        ));
        return resolveCall?.payload?.ref ?? null;
      }).not.toBeNull();
      const resolveCall = (await fixture.getHostInvocations()).filter((call) => (
        call.module === 'files'
        && call.action === 'resolveAttachment'
        && (call.payload?.ref as Record<string, unknown> | undefined)?.uri === spreadsheetPath
      )).at(-1);
      const resolvedRef = resolveCall?.payload?.ref as Record<string, unknown>;
      await fixture.clearInvocations();

      await trigger.click();
      const menu = page.getByTestId('acp-attachment-open-with-menu');
      await expect(menu).toBeVisible();
      const revealLabel = process.platform === 'darwin'
        ? 'Show in Finder'
        : process.platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in file manager';
      await expect(page.getByRole('menuitem', { name: revealLabel, exact: true })).toBeVisible();

      if (process.platform === 'darwin' || process.platform === 'win32') {
        await expect.poll(async () => filesActionCalls(
          await fixture.getHostInvocations(),
          'listAttachmentOpenHandlers',
        ).map((call) => call.payload)).toEqual([resolvedRef]);
        const appRows = page.getByTestId('acp-attachment-open-with-app');
        await expect(appRows).toHaveCount(2);
        await expect(appRows.nth(0)).toHaveText('Zulu Sheets');
        await expect(appRows.nth(1)).toHaveText('Alpha Sheets');
        await expect(appRows.nth(0).getByTestId('acp-attachment-open-with-native-icon')).toHaveAttribute('src', nativeIcon);
        await expect(appRows.nth(0).getByTestId('acp-attachment-open-with-native-icon')).toHaveCSS('width', '20px');
        await expect(appRows.nth(0).getByTestId('acp-attachment-open-with-native-icon')).toHaveCSS('height', '20px');
        await expect(appRows.nth(1).getByTestId('acp-attachment-open-with-generic-icon')).toBeVisible();
        await expect(appRows.nth(1).getByTestId('acp-attachment-open-with-generic-icon')).toHaveCSS('width', '20px');
        await expect(appRows.nth(1).getByTestId('acp-attachment-open-with-generic-icon')).toHaveCSS('height', '20px');

        await page.getByRole('menuitem', { name: 'Alpha Sheets', exact: true }).click();
        await expect.poll(async () => filesActionCalls(
          await fixture.getHostInvocations(),
          'openAttachmentWith',
        ).map((call) => call.payload)).toEqual([{ ref: resolvedRef, handlerId: 'app-alpha' }]);
        await expect(page.getByTestId('artifact-panel')).toHaveCount(0);
        await trigger.click();
      } else {
        await expect(menu.getByRole('menuitem')).toHaveCount(1);
        await expect(page.getByTestId('acp-attachment-open-with-app')).toHaveCount(0);
        expect(filesActionCalls(await fixture.getHostInvocations(), 'listAttachmentOpenHandlers')).toEqual([]);
      }

      await page.getByRole('menuitem', { name: revealLabel, exact: true }).click();
      await expect.poll(async () => filesActionCalls(
        await fixture.getHostInvocations(),
        'revealAttachment',
      ).map((call) => call.payload)).toEqual([resolvedRef]);
      await expect(page.getByTestId('artifact-panel')).toHaveCount(0);

      await fixture.clearInvocations();
      await preview.click();
      const panel = page.getByTestId('artifact-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Operations')).toBeVisible({ timeout: 30_000 });
      const previewCalls = await fixture.getHostInvocations();
      expect(filesActionCalls(previewCalls, 'openAttachmentWith')).toEqual([]);
      expect(filesActionCalls(previewCalls, 'revealAttachment')).toEqual([]);
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the HTML preview and source switcher in the file header', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const htmlPath = await fixture.createWorkspaceFile(
        'inline-preview.html',
        '<!doctype html><html><body><h1>Inline HTML preview</h1></body></html>',
      );
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('html-preview-user', 'Show the HTML file'),
        resourceUpdate({
          messageId: 'html-preview-reply',
          uri: htmlPath,
          name: 'inline-preview.html',
          mimeType: 'text/html',
        }),
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const attachment = page.getByRole('button', { name: 'Preview inline-preview.html', exact: true });
      await expect(attachment).toBeEnabled({ timeout: 30_000 });
      await attachment.click();

      const panel = page.getByTestId('artifact-panel');
      const fileHeader = panel.locator('header').filter({ hasText: 'inline-preview.html' });
      const viewTabs = fileHeader.getByTestId('file-preview-view-tabs');
      await expect(viewTabs).toBeVisible();
      await expect(viewTabs.getByRole('tab', { name: 'Preview', exact: true })).toHaveAttribute('data-state', 'active');
      await expect(panel.getByTestId('html-preview-frame')).toBeVisible();

      await viewTabs.getByRole('tab', { name: 'Source', exact: true }).click();
      await expect(viewTabs.getByRole('tab', { name: 'Source', exact: true })).toHaveAttribute('data-state', 'active');
      await expect(panel.getByTestId('html-preview-frame')).toHaveCount(0);

      await viewTabs.getByRole('tab', { name: 'Preview', exact: true }).click();
      await expect(panel.getByTestId('html-preview-frame')).toBeVisible();
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('silently degrades failed application discovery to reveal', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const pdfPath = await fixture.createWorkspaceFile('discovery-failure.pdf', '%PDF-1.4\n');
      await fixture.setOpenHandlersResult({ ok: false, error: 'operationFailed' });
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('discovery-user', 'Show the PDF'),
        resourceUpdate({
          messageId: 'discovery-reply',
          uri: pdfPath,
          name: 'Discovery failure.pdf',
          mimeType: 'application/pdf',
        }),
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const trigger = page.getByRole('button', { name: 'Open Discovery failure.pdf with', exact: true });
      await expect(trigger).toBeEnabled({ timeout: 30_000 });
      await fixture.clearInvocations();
      await trigger.click();

      const revealLabel = process.platform === 'darwin'
        ? 'Show in Finder'
        : process.platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in file manager';
      await expect(page.getByRole('menuitem', { name: revealLabel, exact: true })).toBeVisible();
      await expect(page.getByTestId('acp-attachment-open-with-loading')).toHaveCount(0);
      await expect(page.getByTestId('acp-attachment-open-with-app')).toHaveCount(0);
      await expect(page.getByText('Could not open attachment with the selected application')).toHaveCount(0);
      if (process.platform === 'linux') {
        expect(filesActionCalls(await fixture.getHostInvocations(), 'listAttachmentOpenHandlers')).toEqual([]);
      } else {
        await expect.poll(async () => filesActionCalls(
          await fixture.getHostInvocations(),
          'listAttachmentOpenHandlers',
        )).toHaveLength(1);
      }
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not expose open-with for user, remote, unavailable, or system-open attachments', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const userPath = await fixture.createWorkspaceFile('user-report.pdf', '%PDF-1.4\n');
      const zipPath = await fixture.createWorkspaceFile('system-open.zip', Uint8Array.from([80, 75, 3, 4]));
      const missingPath = `${fixture.workspaceDir}/missing-report.pdf`;
      await fixture.registerStagedAttachment('stage-user-report', userPath, '/Users/test/Documents/user-report.pdf');
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'ineligible-user',
          content: [{
            type: 'resource_link',
            uri: userPath,
            name: 'User report.pdf',
            mimeType: 'application/pdf',
            _meta: { clawx: { stagingId: 'stage-user-report' } },
          }],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'ineligible-reply',
          content: [
            { type: 'resource_link', uri: 'https://example.test/remote-report.pdf', name: 'Remote report.pdf', mimeType: 'application/pdf' },
            { type: 'resource_link', uri: missingPath, name: 'Missing report.pdf', mimeType: 'application/pdf' },
            { type: 'resource_link', uri: zipPath, name: 'System open.zip', mimeType: 'application/zip' },
          ],
        },
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      await expect(page.getByText('User report.pdf')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('Remote report.pdf')).toBeVisible();
      await expect(page.getByText('Missing report.pdf')).toBeVisible();
      await expect(page.getByText('System open.zip')).toBeVisible();
      for (const name of ['User report.pdf', 'Remote report.pdf', 'Missing report.pdf', 'System open.zip']) {
        await expect(page.getByRole('button', { name: `Open ${name} with`, exact: true })).toHaveCount(0);
      }
      await expect(page.getByTestId('acp-attachment-open-with-trigger')).toHaveCount(0);
      expect(filesActionCalls(await fixture.getHostInvocations(), 'listAttachmentOpenHandlers')).toEqual([]);
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('plays authorized local videos through a revocable stream and keeps remote videos as links', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const remoteUrl = 'https://example.test/generated/remote-video.mp4';

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [
          { key: MAIN_SESSION_KEY, title: 'Main session' },
          { key: OTHER_SESSION_KEY, title: 'Other session' },
        ],
      });
      const localVideoPath = await fixture.createOpenClawMediaFile(
        'tool-video-generation/local-playback.m4v',
        playableVideoBytes(),
      );
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('video-user', 'Show both generated videos'),
        {
          sessionUpdate: 'agent_message',
          messageId: 'video-reply',
          content: [
            { type: 'text', text: 'The generated videos are ready.' },
            {
              type: 'resource_link',
              uri: localVideoPath,
              name: 'Local playback.m4v',
              mimeType: 'video/x-m4v',
            },
            {
              type: 'resource_link',
              uri: remoteUrl,
              name: 'Remote video.mp4',
              mimeType: 'video/mp4',
            },
          ],
        },
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const player = page.getByTestId('acp-video-player');
      await expect(player).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('acp-video-attachment')).toHaveCount(1);
      const firstStreamUrl = await player.getAttribute('src');
      expect(firstStreamUrl).toMatch(/^uclaw-media:\/\/attachment\/[A-Za-z0-9_-]+$/);
      expect(firstStreamUrl).not.toContain(localVideoPath);
      await expect(page.getByRole('button', { name: 'Open Remote video.mp4', exact: true })).toBeEnabled();

      const playbackState = await player.evaluate(async (node) => {
        const video = node as HTMLVideoElement;
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
          await new Promise<void>((resolveMetadata, rejectMetadata) => {
            video.addEventListener('loadedmetadata', () => resolveMetadata(), { once: true });
            video.addEventListener('error', () => rejectMetadata(new Error('Video metadata failed to load')), { once: true });
          });
        }
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          throw new Error(`Expected a finite video duration, received ${video.duration}`);
        }
        const targetTime = Math.min(video.duration / 2, 0.08);
        video.currentTime = targetTime;
        await new Promise<void>((resolveSeek, rejectSeek) => {
          video.addEventListener('seeked', () => resolveSeek(), { once: true });
          video.addEventListener('error', () => rejectSeek(new Error('Video seek failed')), { once: true });
        });
        return {
          currentTime: video.currentTime,
          duration: video.duration,
          readyState: video.readyState,
        };
      });
      expect(playbackState.duration).toBeGreaterThan(0);
      expect(playbackState.currentTime).toBeGreaterThan(0);
      expect(playbackState.readyState).toBeGreaterThanOrEqual(1);

      await page.getByTestId(`sidebar-session-${OTHER_SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      const firstStreamId = firstStreamUrl?.split('/').at(-1);
      await expect.poll(async () => (await fixture.getHostInvocations()).some((call) => (
        call.module === 'files'
        && call.action === 'releaseAttachmentPlayback'
        && call.payload?.streamId === firstStreamId
      ))).toBe(true);

      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();
      await expect(player).toBeVisible({ timeout: 30_000 });
      const secondStreamUrl = await player.getAttribute('src');
      expect(secondStreamUrl).toMatch(/^uclaw-media:\/\/attachment\/[A-Za-z0-9_-]+$/);
      expect(secondStreamUrl).not.toBe(firstStreamUrl);
      await expect(page.getByTestId('acp-video-attachment')).toHaveCount(1);
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders user image thumbnails and actionable file paths', async ({ launchElectronApp }, testInfo) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const imageBytes = Uint8Array.from(Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1440" viewBox="0 0 960 1440"><rect width="960" height="1440" fill="#b91c1c"/></svg>',
        'utf8',
      ));
      const imagePath = await fixture.createWorkspaceFile('uploads/photo.svg', imageBytes);
      const notesPath = await fixture.createWorkspaceFile('uploads/notes.txt', 'Preview this user attachment.');
      const displayImagePath = '/Users/test/Pictures/photo.svg';
      const displayNotesPath = '/Users/test/Documents/a/very/long/path/notes.txt';
      await fixture.registerStagedAttachment('stage-photo', imagePath, displayImagePath);
      await fixture.registerStagedAttachment('stage-notes', notesPath, displayNotesPath);
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [{
        sessionUpdate: 'user_message',
        messageId: 'user-attachments',
        content: [
          { type: 'text', text: 'Review these files.' },
          {
            type: 'image',
            uri: imagePath,
            data: Buffer.from(imageBytes).toString('base64'),
            mimeType: 'image/svg+xml',
            _meta: { clawx: { stagingId: 'stage-photo', fileName: 'photo.svg' } },
          },
          {
            type: 'resource_link',
            uri: notesPath,
            name: 'notes.txt',
            mimeType: 'text/plain',
            _meta: { clawx: { stagingId: 'stage-notes' } },
          },
        ],
      }]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const userMessage = page.getByTestId('acp-user-message');
      await expect(userMessage.getByText('Review these files.')).toBeVisible({ timeout: 30_000 });
      const thumbnail = page.getByTestId('acp-user-image-attachment');
      await expect(thumbnail).toBeVisible();
      await expect(thumbnail).toHaveAttribute('alt', 'photo.svg');
      const thumbnailContainer = page.getByTestId('acp-user-image-thumbnail');
      const [bubbleBox, thumbnailBox] = await Promise.all([
        userMessage.locator('.bg-brand').first().boundingBox(),
        thumbnailContainer.boundingBox(),
      ]);
      expect(bubbleBox).not.toBeNull();
      expect(thumbnailBox).not.toBeNull();
      expect(thumbnailBox!.width).toBeGreaterThanOrEqual(140);
      expect(thumbnailBox!.width).toBeLessThanOrEqual(146);
      expect(thumbnailBox!.height).toBeGreaterThanOrEqual(140);
      expect(thumbnailBox!.height).toBeLessThanOrEqual(146);
      expect(Math.abs((bubbleBox!.x + bubbleBox!.width) - (thumbnailBox!.x + thumbnailBox!.width))).toBeLessThanOrEqual(1);
      await expect(page.getByTestId('acp-user-image-overlay')).toContainText('photo.svg');
      const screenshotPath = testInfo.outputPath('user-image-attachment-thumbnail.png');
      await thumbnailContainer.screenshot({ path: screenshotPath });
      await testInfo.attach('user-image-attachment-thumbnail', {
        path: screenshotPath,
        contentType: 'image/png',
      });

      const notes = page.getByRole('button', { name: 'Preview notes.txt' });
      await expect(notes).toContainText(displayNotesPath);
      await expect(notes).not.toContainText('text/plain');
      await notes.click();
      const panel = page.getByTestId('artifact-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('Preview this user attachment.')).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await fixture.getHostInvocations()).some((call) => (
        call.module === 'media'
        && call.action === 'thumbnails'
        && Array.isArray(call.payload?.paths)
        && (call.payload.paths as Array<Record<string, unknown>>).some((entry) => (
          (entry.attachmentFileRef as Record<string, unknown> | undefined)?.uri === imagePath
        ))
      ))).toBe(true);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('recovers assistant MEDIA for a user turn with a resource attachment', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const prompt = 'Create the attached-source report';
    const reply = 'The attached-source report is ready.';

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [
          { key: MAIN_SESSION_KEY, title: 'Main session' },
          { key: OTHER_SESSION_KEY, title: 'Other session' },
        ],
      });
      const sourcePath = await fixture.createWorkspaceFile('attached-source.xlsx', workbookBytes());
      const outputPath = await fixture.createWorkspaceFile('attached-output.xlsx', workbookBytes());
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        {
          sessionUpdate: 'user_message',
          messageId: 'attached-source-user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'resource_link',
              uri: sourcePath,
              name: 'attached-source.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
          ],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'attached-source-reply',
          content: [{ type: 'text', text: reply }],
        },
      ]);
      const transcript = [
        {
          role: 'user',
          id: 'attached-source-transcript-user',
          content: `[Working directory: ${fixture.workspaceDir}]\n\n${prompt}\n[Resource link] ${sourcePath}`,
        },
        {
          role: 'assistant',
          id: 'attached-source-transcript-assistant',
          content: `${reply}\nMEDIA:${outputPath}`,
        },
      ];
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 });
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 1);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [transcript]);

      await page.getByTestId(`sidebar-session-${OTHER_SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();

      await expect(page.getByRole('button').filter({ hasText: 'attached-output.xlsx' })).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText(/MEDIA:/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('previews the reported live spreadsheet flow and restores one historical card', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [
          { key: MAIN_SESSION_KEY, title: 'Main session' },
          { key: OTHER_SESSION_KEY, title: 'Other session' },
        ],
      });
      const spreadsheetPath = await fixture.createWorkspaceFile('budget_sample.xlsx', workbookBytes());
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);
      await fixture.setPromptUpdates(PROMPT, reportedFlowUpdates());

      const page = await openChat(app);
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 1);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[
        { role: 'user', id: 'transcript-user-budget', content: PROMPT },
        {
          role: 'assistant',
          id: 'transcript-assistant-budget',
          content: `MEDIA:${spreadsheetPath}\n${REPLY}`,
        },
      ]]);

      await page.getByTestId('chat-composer-input').fill(PROMPT);
      await page.getByTestId('chat-composer-send').click();

      const turn = page.getByTestId('acp-assistant-turn').last();
      const prose = turn.getByText(REPLY);
      const attachment = turn.getByRole('button').filter({ hasText: 'budget_sample.xlsx' });
      await expect(prose).toBeVisible({ timeout: 30_000 });
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 2);
      await expect(attachment).toBeVisible();
      await expect(page.getByText(/MEDIA:/)).toHaveCount(0);
      await expect.poll(async () => prose.evaluate((node, card) => (
        Boolean(node.compareDocumentPosition(card as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
      ), await attachment.elementHandle())).toBe(true);

      await attachment.click();
      const panel = page.getByTestId('artifact-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('artifact-panel-tab-preview')).toBeVisible();
      await expect(panel.getByText('Operations')).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await fixture.getHostInvocations()).some((call) => (
        call.module === 'files'
        && call.action === 'readAttachmentBinary'
        && call.payload?.ref
        && (call.payload.ref as Record<string, unknown>).uri === spreadsheetPath
      ))).toBe(true);

      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        { sessionUpdate: 'user_message', messageId: 'history-user-budget', content: [{ type: 'text', text: PROMPT }] },
        ...reportedFlowUpdates(),
      ]);
      await page.getByTestId(`sidebar-session-${OTHER_SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();

      await expect(page.getByRole('button').filter({ hasText: 'budget_sample.xlsx' })).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText(/MEDIA:/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps one live image reply when transcript media arrives before streamed ACP text', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const prompt = 'Generate a rabbit walking through a shopping street';
    const caption = 'The generated rabbit street photo is ready.';
    const taskId = '76ee7e56-e49f-4f9c-bf50-680008e3e747';

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const imagePath = await fixture.createOpenClawMediaFile(
        'tool-image-generation/live-rabbit.png',
        Uint8Array.from(Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        )),
      );
      const taskStartedText = `Background task started for image generation (${taskId}).`;
      await fixture.setPromptUpdates(prompt, [{
        sessionUpdate: 'tool_call_update',
        toolCallId: 'image-tool-live-history',
        status: 'completed',
        content: [{
          type: 'content',
          content: { type: 'text', text: taskStartedText },
        }],
      }]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[], [
        { role: 'user', id: 'rabbit-live-user', content: prompt },
        {
          role: 'toolresult',
          toolCallId: 'image-tool-live-history',
          toolName: 'image_generate',
          content: taskStartedText,
          details: { taskId },
        },
        {
          role: 'user',
          content: `[Inter-session message] sourceSession=image_generate:${taskId} sourceChannel=webchat sourceTool=image_generate isUser=false\n[Internal task completion event]\nstatus: completed successfully`,
          provenance: {
            kind: 'inter_session',
            sourceSessionKey: `image_generate:${taskId}`,
            sourceTool: 'image_generate',
          },
        },
        {
          role: 'assistant',
          id: 'rabbit-live-transcript-completion',
          content: `${caption}\n\nMEDIA:${imagePath}`,
        },
      ]]);

      const page = await openChat(app);
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 1);
      await page.getByTestId('chat-composer-input').fill(prompt);
      await page.getByTestId('chat-composer-send').click();
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 2);

      const timeline = page.getByTestId('acp-chat-timeline');
      await expect(timeline.getByText(caption, { exact: true })).toHaveCount(1, { timeout: 30_000 });
      await expect(timeline.getByTestId('acp-image-part')).toHaveCount(1);

      await fixture.emitAcpSessionUpdates({
        sessionKey: MAIN_SESSION_KEY,
        updates: [{
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: caption },
        }],
      });

      await expect(timeline.getByText(caption, { exact: true })).toHaveCount(1);
      await expect(timeline.getByTestId('acp-image-part')).toHaveCount(1);
      await expect(page.getByText(/MEDIA:/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders native ACP resources without transcript evidence and prefers them over duplicate MEDIA evidence', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [
          { key: MAIN_SESSION_KEY, title: 'Main session' },
          { key: OTHER_SESSION_KEY, title: 'Other session' },
        ],
      });
      const spreadsheetPath = await fixture.createWorkspaceFile('native-budget.xlsx', workbookBytes());
      const replay = [
        userUpdate('native-user', 'Show the native budget'),
        resourceUpdate({
          messageId: 'native-reply',
          uri: spreadsheetPath,
          name: 'Native budget.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          text: 'The native ACP resource is ready.',
        }),
      ];
      await fixture.setSessionReplay(MAIN_SESSION_KEY, replay);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const nativeCard = page.getByRole('button', { name: 'Preview Native budget.xlsx', exact: true });
      await expect(nativeCard).toBeEnabled({ timeout: 30_000 });

      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[
        { role: 'user', id: 'native-transcript-user', content: 'Show the native budget' },
        {
          role: 'assistant',
          id: 'native-transcript-assistant',
          content: `MEDIA:${spreadsheetPath}\nThe native ACP resource is ready.`,
        },
      ]]);
      await page.getByTestId(`sidebar-session-${OTHER_SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();

      await expect(page.getByRole('button', { name: 'Preview Native budget.xlsx', exact: true })).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Preview native-budget.xlsx', exact: true })).toHaveCount(0);
      await expect(page.getByText(/MEDIA:/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('routes ZIP and HTTPS attachments through validated Main system-open operations', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const remoteUrl = 'https://example.test/files/remote-archive.zip';

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const zipPath = await fixture.createOpenClawMediaFile('exports/budget-archive.zip', Uint8Array.from([80, 75, 3, 4]));
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('open-user', 'Open the archives'),
        {
          sessionUpdate: 'agent_message',
          messageId: 'open-reply',
          content: [
            { type: 'text', text: 'Both archives are ready.' },
            { type: 'resource_link', uri: zipPath, name: 'budget-archive.zip', mimeType: 'application/zip' },
            { type: 'resource_link', uri: remoteUrl, name: 'remote-archive.zip', mimeType: 'application/zip' },
          ],
        },
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const localCard = page.getByRole('button').filter({ hasText: 'budget-archive.zip' });
      const remoteCard = page.getByRole('button').filter({ hasText: 'remote-archive.zip' });
      await expect(localCard).toBeEnabled({ timeout: 30_000 });
      await expect(remoteCard).toBeEnabled();
      await fixture.clearInvocations();

      await localCard.click();
      await expect.poll(async () => (await fixture.getShellInvocations()).some((call) => (
        call.action === 'openPath' && call.payload?.path === zipPath
      ))).toBe(true);
      await remoteCard.click();
      await expect.poll(async () => (await fixture.getShellInvocations()).some((call) => (
        call.action === 'openExternal' && call.payload?.url === remoteUrl
      ))).toBe(true);
      const hostCalls = await fixture.getHostInvocations();
      expect(hostCalls.filter((call) => call.module === 'files' && call.action === 'openAttachment')).toHaveLength(2);
      expect(await getRecordedLegacyIpcInvocations(app)).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('previews outside-workspace paths through attachment host APIs', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const outsidePath = await fixture.createOutsideFile('private.txt', 'not authorized');
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('outside-user', 'Show the private file'),
        resourceUpdate({
          messageId: 'outside-reply',
          uri: outsidePath,
          name: 'private.txt',
          mimeType: 'text/plain',
          text: 'The requested path is not in the workspace.',
        }),
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const outsideCard = page.getByRole('button', { name: 'Preview private.txt', exact: true });
      await expect(outsideCard).toBeEnabled({ timeout: 30_000 });
      await expect(outsideCard).toContainText(outsidePath);
      const calls = await fixture.getHostInvocations();
      expect(calls.some((call) => (
        call.module === 'files'
        && call.action === 'resolveAttachment'
        && call.payload?.ref
        && (call.payload.ref as Record<string, unknown>).uri === outsidePath
      ))).toBe(true);
      await fixture.clearInvocations();

      await outsideCard.click();
      const panel = page.getByTestId('artifact-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByText('not authorized')).toBeVisible({ timeout: 30_000 });
      const previewCalls = await fixture.getHostInvocations();
      expect(previewCalls.some((call) => (
        call.module === 'files'
        && call.action === 'readAttachmentText'
        && call.payload?.uri === outsidePath
      ))).toBe(true);
      expect(await fixture.getShellInvocations()).toEqual([]);
      expect((await getRecordedLegacyIpcInvocations(app)).filter((call) => (
        call.channel === 'file:readText'
        || call.channel === 'file:readBinary'
        || call.channel.startsWith('shell:')
      ))).toEqual([]);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('drops a delayed 1500 ms transcript retry after switching sessions', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const retryPrompt = 'Prepare the delayed attachment';

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [
          { key: MAIN_SESSION_KEY, title: 'Main session' },
          { key: OTHER_SESSION_KEY, title: 'Other session' },
        ],
      });
      const delayedPath = await fixture.createWorkspaceFile('delayed.txt', 'delayed attachment');
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);
      await fixture.setPromptUpdates(retryPrompt, [{
        sessionUpdate: 'agent_message',
        messageId: 'delayed-reply',
        content: [{ type: 'text', text: 'The attachment will arrive shortly.' }],
      }]);

      const page = await openChat(app);
      await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 1);
      // Drain duplicate startup transcript fetches (Strict Mode / remount) before
      // arming the deferred live retry response, otherwise an extra historical
      // read can consume the deferred slot and make the 1500ms gap look ~0ms.
      await fixture.waitForHistoryQuiet(MAIN_SESSION_KEY);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [
        [],
        {
          deferId: 'delayed-retry',
          messages: [
            { role: 'user', id: 'delayed-transcript-user', content: retryPrompt },
            {
              role: 'assistant',
              id: 'delayed-transcript-assistant',
              content: `MEDIA:${delayedPath}\nThe attachment will arrive shortly.`,
            },
          ],
        },
      ]);
      await fixture.clearHistoryRequestTimes(MAIN_SESSION_KEY);
      await expect(fixture.releaseTranscriptResponse('delayed-retry')).rejects.toThrow(
        'Deferred transcript response is not ready: delayed-retry',
      );
      await page.getByTestId('chat-composer-input').fill(retryPrompt);
      await page.getByTestId('chat-composer-send').click();

      const requestTimes = await fixture.waitForHistoryRequestCount(MAIN_SESSION_KEY, 2, 6_000);
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_400);
      await fixture.waitForDeferredTranscriptReady('delayed-retry');
      await page.getByTestId(`sidebar-session-${OTHER_SESSION_KEY}`).click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      await fixture.releaseTranscriptResponse('delayed-retry');
      await fixture.waitForDeferredTranscriptCompleted('delayed-retry');

      await expect(page.getByRole('button').filter({ hasText: 'delayed.txt' })).toHaveCount(0);
      await expect(page.getByText('The attachment will arrive shortly.')).toHaveCount(0);
      expect((await fixture.getHostInvocations()).some((call) => (
        call.module === 'files'
        && (call.action === 'readAttachmentBinary' || call.action === 'openAttachment')
      ))).toBe(false);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('lifts an early attachment after later prose and before file activity', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: MAIN_SESSION_KEY, title: 'Main session' }],
      });
      const earlyPath = await fixture.createWorkspaceFile('early.txt', 'early attachment');
      await fixture.setSessionReplay(MAIN_SESSION_KEY, [
        userUpdate('ordering-user', 'Create the ordered output'),
        resourceUpdate({
          messageId: 'ordering-resource',
          uri: earlyPath,
          name: 'early.txt',
          mimeType: 'text/plain',
        }),
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'ordering-write',
          title: 'Write: activity.txt',
          status: 'in_progress',
          rawInput: { path: 'activity.txt', content: 'created' },
          content: [{ type: 'content', content: { type: 'text', text: 'Writing activity.txt' } }],
          locations: [],
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'ordering-write',
          title: 'Write: activity.txt',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Write complete' } }],
          locations: [],
        },
        {
          sessionUpdate: 'agent_message',
          messageId: 'ordering-prose',
          content: [{ type: 'text', text: 'The ordered output is complete.' }],
        },
      ]);
      await fixture.setTranscriptResponses(MAIN_SESSION_KEY, [[]]);

      const page = await openChat(app);
      const turn = page.getByTestId('acp-assistant-turn');
      const prose = turn.getByText('The ordered output is complete.');
      const attachment = turn.getByRole('button').filter({ hasText: 'early.txt' });
      const activity = turn.getByTestId('acp-turn-file-activity');
      await expect(prose).toBeVisible({ timeout: 30_000 });
      await expect(attachment).toBeEnabled();
      await expect(activity).toBeVisible();
      const attachmentHandle = await attachment.elementHandle();
      const activityHandle = await activity.elementHandle();
      if (!attachmentHandle || !activityHandle) throw new Error('Expected ordered attachment and activity elements');
      expect(await prose.evaluate((node, card) => (
        Boolean(node.compareDocumentPosition(card as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
      ), attachmentHandle)).toBe(true);
      expect(await attachment.evaluate((node, summary) => (
        Boolean(node.compareDocumentPosition(summary as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
      ), activityHandle)).toBe(true);
    } finally {
      await closeElectronApp(app);
    }
  });
});
