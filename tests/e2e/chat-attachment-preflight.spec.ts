import type { ElectronApplication, Page } from '@playwright/test';
import type { AcpChatLoadPayload, AcpChatOperationResult, AcpChatPromptPayload } from '../../shared/acp-chat/types';
import { CHAT_MEDIA_MAX_ITEMS } from '../../shared/chat/media-limits';
import type { StagedFileResult } from '../../shared/host-api/contract';
import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
  type AttachmentHostFixture,
  type RecordedHostInvocation,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const DRAFT = 'Keep this attachment preflight draft';
const LOAD_ERROR = 'Attachment preflight fixture rejected session load';

type LoadResult = { payload: AcpChatLoadPayload; result: AcpChatOperationResult };
type PreflightSnapshot = {
  requests: RecordedHostInvocation[];
  stagedFiles: StagedFileResult[];
  loadResults: LoadResult[];
  pendingLoad: AcpChatLoadPayload | null;
};
type PreflightState = PreflightSnapshot & {
  selection: string[];
  rejectNextLocalLoad: boolean;
  releaseLoad: (() => void) | null;
};

/** Intercept Main's contract, not React callbacks; staging remains production-owned. */
async function installPreflightInterceptor(app: ElectronApplication) {
  await app.evaluate(({ app: _app }, { mainSessionKey, loadError }) => {
    const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
    type HostRequest = RecordedHostInvocation & { id: string };
    type HostResponse = { id?: string; ok: boolean; data?: unknown };
    type HostHandler = (event: unknown, request: HostRequest) => Promise<HostResponse>;
    const original = (ipcMain as unknown as {
      _invokeHandlers: Map<string, HostHandler>;
    })._invokeHandlers.get('host:invoke');
    if (!original) throw new Error('Attachment preflight requires the installed Main host fixture');

    const state: PreflightState = {
      requests: [],
      stagedFiles: [],
      loadResults: [],
      pendingLoad: null,
      selection: [],
      rejectNextLocalLoad: false,
      releaseLoad: null,
    };
    (globalThis as unknown as { __e2eAttachmentPreflight: PreflightState }).__e2eAttachmentPreflight = state;
    const respond = (id: string, data: unknown): HostResponse => ({ id, ok: true, data });

    ipcMain.removeHandler('host:invoke');
    ipcMain.handle('host:invoke', async (event, request: HostRequest) => {
      state.requests.push({ module: request.module, action: request.action, payload: request.payload });
      if (request.module === 'dialog' && request.action === 'open') {
        const filePaths = state.selection;
        state.selection = [];
        return respond(request.id, { canceled: filePaths.length === 0, filePaths });
      }
      // Disable optional planners/rule capture so no prompt reaches a paid provider.
      if (request.module === 'artifactTasks' && request.action === 'prepare') {
        return respond(request.id, {
          artifactTask: false,
          effectiveSessionKey: request.payload?.sessionKey,
          createSession: false,
        });
      }
      if (request.module === 'longTermRules' && request.action === 'capture') {
        return respond(request.id, { captured: false });
      }
      if (request.module === 'chat' && request.action === 'loadAcpSession') {
        const payload = request.payload as unknown as AcpChatLoadPayload;
        if (state.rejectNextLocalLoad && payload.sessionKey !== mainSessionKey) {
          state.rejectNextLocalLoad = false;
          state.pendingLoad = payload;
          await new Promise<void>((resolveLoad) => { state.releaseLoad = resolveLoad; });
          state.pendingLoad = null;
          state.releaseLoad = null;
          // Business rejection inside a successful host envelope is the real load contract.
          const result: AcpChatOperationResult = { success: false, error: loadError, retryable: true };
          state.loadResults.push({ payload, result });
          return respond(request.id, result);
        }
        const response = await original(event, request);
        if (response.ok) {
          state.loadResults.push({ payload, result: response.data as AcpChatOperationResult });
        }
        return response;
      }

      // sendAcpPrompt is handled by installAttachmentHostFixture, never by a real ACP/model.
      const response = await original(event, request);
      if (response.ok && request.module === 'files') {
        if (request.action === 'stagePaths') {
          state.stagedFiles.push(...response.data as StagedFileResult[]);
        } else if (request.action === 'stageBuffer') {
          state.stagedFiles.push(response.data as StagedFileResult);
        }
      }
      return response;
    });
  }, { mainSessionKey: SESSION_KEY, loadError: LOAD_ERROR });

  return {
    read: async (): Promise<PreflightSnapshot> => app.evaluate(() => {
      const state = (globalThis as unknown as {
        __e2eAttachmentPreflight: PreflightState;
      }).__e2eAttachmentPreflight;
      return {
        requests: state.requests,
        stagedFiles: state.stagedFiles,
        loadResults: state.loadResults,
        pendingLoad: state.pendingLoad,
      };
    }),
    selectFiles: async (filePaths: string[]) => app.evaluate(({ app: _app }, selection) => {
      (globalThis as unknown as {
        __e2eAttachmentPreflight: PreflightState;
      }).__e2eAttachmentPreflight.selection = selection;
    }, filePaths),
    rejectNextLocalLoad: async () => app.evaluate(() => {
      (globalThis as unknown as {
        __e2eAttachmentPreflight: PreflightState;
      }).__e2eAttachmentPreflight.rejectNextLocalLoad = true;
    }),
    releaseRejectedLoad: async () => app.evaluate(() => {
      const state = (globalThis as unknown as {
        __e2eAttachmentPreflight: PreflightState;
      }).__e2eAttachmentPreflight;
      if (!state.releaseLoad) throw new Error('No pre-send session load is waiting for rejection');
      state.releaseLoad();
    }),
  };
}

type PreflightInterceptor = Awaited<ReturnType<typeof installPreflightInterceptor>>;

function stagingRequests(snapshot: PreflightSnapshot): RecordedHostInvocation[] {
  return snapshot.requests.filter((request) => (
    request.module === 'files' && (request.action === 'stagePaths' || request.action === 'stageBuffer')
  ));
}

function promptRequests(snapshot: PreflightSnapshot): AcpChatPromptPayload[] {
  return snapshot.requests
    .filter((request) => request.module === 'chat' && request.action === 'sendAcpPrompt')
    .map((request) => request.payload as unknown as AcpChatPromptPayload);
}

function mediaPayload(files: StagedFileResult[]) {
  return files.map((file) => ({
    filePath: file.stagedPath,
    stagingId: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
  }));
}

async function createTextFiles(fixture: AttachmentHostFixture, count: number): Promise<string[]> {
  const filePaths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    filePaths.push(await fixture.createWorkspaceFile(`preflight-${index}.txt`, `Fixture attachment ${index}\n`));
  }
  return filePaths;
}

async function dropTextFiles(page: Page, fileNames: string[]): Promise<void> {
  await page.getByTestId('chat-composer-input').evaluate((composer, names) => {
    const dataTransfer = new DataTransfer();
    for (const name of names) {
      dataTransfer.items.add(new File([`Fixture attachment ${name}\n`], name, { type: 'text/plain' }));
    }
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, fileNames);
}

async function openChat(app: ElectronApplication, host: PreflightInterceptor): Promise<Page> {
  const page = await getStableWindow(app);
  await page.reload();
  await expect(page.getByTestId('main-layout')).toBeVisible();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await expect.poll(async () => (await host.read()).loadResults.some((load) => (
    load.payload.sessionKey === SESSION_KEY && load.result.success
  ))).toBe(true);
  await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
  return page;
}

test.describe('Chat attachment preflight', () => {
  for (const source of ['selection', 'drop'] as const) {
    test(`rejects a nine-file ${source} as a whole batch before staging IPC`, async ({ launchElectronApp }) => {
      const app = await launchElectronApp({ skipSetup: true, managedProvider: true });
      try {
        const fixture = await installAttachmentHostFixture(app, {
          sessions: [{ key: SESSION_KEY, title: 'Attachment preflight' }],
        });
        const host = await installPreflightInterceptor(app);
        const page = await openChat(app, host);
        const fileNames = Array.from({ length: 9 }, (_, index) => `preflight-${index}.txt`);
        await page.getByTestId('chat-composer-input').fill(DRAFT);

        if (source === 'selection') {
          await host.selectFiles(await createTextFiles(fixture, 9));
          await page.getByTestId('chat-composer-attach').click();
        } else {
          await dropTextFiles(page, fileNames);
        }

        await expect(page.getByText('A message can include at most 8 attachments', { exact: true })).toBeVisible();
        const snapshot = await host.read();
        expect(CHAT_MEDIA_MAX_ITEMS).toBe(8);
        expect(stagingRequests(snapshot)).toEqual([]);
        expect(snapshot.stagedFiles).toEqual([]);
        expect(promptRequests(snapshot)).toEqual([]);
        if (source === 'selection') {
          expect(snapshot.requests.filter((request) => request.module === 'dialog' && request.action === 'open'))
            .toHaveLength(1);
        }
        await expect(page.getByTestId('chat-composer-input')).toHaveValue(DRAFT);
        for (const fileName of fileNames) await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);
      } finally {
        await closeElectronApp(app);
      }
    });
  }

  test('rejects an additional attachment at eight and sends only the original staged identities', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, managedProvider: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Attachment preflight' }],
      });
      const host = await installPreflightInterceptor(app);
      const page = await openChat(app, host);
      const fileNames = Array.from({ length: 8 }, (_, index) => `dropped-${index}.txt`);
      await page.getByTestId('chat-composer-input').fill(DRAFT);
      await dropTextFiles(page, fileNames);
      await expect.poll(async () => (await host.read()).stagedFiles).toHaveLength(8);
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
      const before = await host.read();
      expect(stagingRequests(before).map((request) => request.action)).toEqual(Array(8).fill('stageBuffer'));
      expect(before.stagedFiles.map((file) => file.fileName)).toEqual(fileNames);
      expect(promptRequests(before)).toEqual([]);

      const extraPath = await fixture.createWorkspaceFile('ninth-rejected.txt', 'Must not be staged\n');
      await host.selectFiles([extraPath]);
      await page.getByTestId('chat-composer-attach').click();
      await expect(page.getByText('A message can include at most 8 attachments', { exact: true })).toBeVisible();
      const after = await host.read();
      expect(stagingRequests(after)).toEqual(stagingRequests(before));
      expect(after.stagedFiles).toEqual(before.stagedFiles);
      expect(promptRequests(after)).toEqual([]);
      await expect(page.getByTestId('chat-composer-input')).toHaveValue(DRAFT);
      await expect(page.getByText('ninth-rejected.txt', { exact: true })).toHaveCount(0);
      for (const fileName of fileNames) await expect(page.getByText(fileName, { exact: true })).toBeVisible();

      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => promptRequests(await host.read())).toHaveLength(1);
      expect(promptRequests(await host.read())[0]).toMatchObject({
        sessionKey: SESSION_KEY,
        message: DRAFT,
        media: mediaPayload(before.stagedFiles),
      });
      expect(promptRequests(await host.read())[0].media).toHaveLength(8);
      await expect(page.getByTestId('chat-composer-input')).toHaveValue('');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('preserves draft and staged attachments when pre-send session load returns false, then retries unchanged', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, managedProvider: true });
    try {
      const fixture = await installAttachmentHostFixture(app, {
        sessions: [{ key: SESSION_KEY, title: 'Attachment preflight' }],
      });
      const host = await installPreflightInterceptor(app);
      const page = await openChat(app, host);
      await page.getByTestId('sidebar-new-chat').click();
      await expect(page.getByTestId('acp-chat-empty-state')).toBeVisible();
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
      await page.getByTestId('chat-composer-input').fill(DRAFT);
      const filePaths = await createTextFiles(fixture, 2);
      await host.selectFiles(filePaths);
      await page.getByTestId('chat-composer-attach').click();
      await expect.poll(async () => (await host.read()).stagedFiles).toHaveLength(2);
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
      const before = await host.read();
      expect(stagingRequests(before)).toHaveLength(1);
      expect(stagingRequests(before)[0]).toMatchObject({ action: 'stagePaths', payload: { filePaths } });
      expect(before.loadResults.every((load) => load.payload.sessionKey === SESSION_KEY)).toBe(true);

      // A local New Chat has no background ACP load: this request comes from onSend's preflight.
      await host.rejectNextLocalLoad();
      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => (await host.read()).pendingLoad).not.toBeNull();
      const pendingLoad = (await host.read()).pendingLoad!;
      expect(pendingLoad).toMatchObject({
        workspaceRoot: fixture.workspaceDir,
        cwd: fixture.workspaceDir,
      });
      expect(pendingLoad.sessionKey).not.toBe(SESSION_KEY);
      expect(pendingLoad.sessionKey).toMatch(/^agent:main:session-/u);
      const pending = await host.read();
      expect(pending.requests.find((request) => (
        request.module === 'artifactTasks' && request.action === 'prepare'
      ))?.payload).toMatchObject({ sessionKey: pendingLoad.sessionKey, message: DRAFT });
      expect(pending.requests.filter((request) => (
        request.module === 'chat'
        && request.action === 'loadAcpSession'
        && request.payload?.sessionKey === pendingLoad.sessionKey
      ))).toHaveLength(1);
      expect(promptRequests(pending)).toEqual([]);

      await host.releaseRejectedLoad();
      await expect.poll(async () => (await host.read()).loadResults.filter((load) => !load.result.success))
        .toHaveLength(1);
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
      // Drain rendering after the host response so a delayed draft clear cannot pass the assertion.
      await page.evaluate(() => new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
      }));
      const rejected = await host.read();
      expect(rejected.loadResults.find((load) => !load.result.success)).toEqual({
        payload: pendingLoad,
        result: { success: false, error: LOAD_ERROR, retryable: true },
      });
      expect(promptRequests(rejected)).toEqual([]);
      expect(stagingRequests(rejected)).toEqual(stagingRequests(before));
      expect(rejected.stagedFiles).toEqual(before.stagedFiles);
      await expect(page.getByTestId('chat-composer-input')).toHaveValue(DRAFT);
      for (const file of before.stagedFiles) await expect(page.getByText(file.fileName, { exact: true })).toBeVisible();

      await page.getByTestId('chat-composer-send').click();
      await expect.poll(async () => promptRequests(await host.read())).toHaveLength(1);
      const retried = await host.read();
      expect(retried.loadResults.some((load) => (
        load.payload.sessionKey === pendingLoad.sessionKey && load.result.success
      ))).toBe(true);
      expect(promptRequests(retried)[0]).toMatchObject({
        sessionKey: pendingLoad.sessionKey,
        message: DRAFT,
        media: mediaPayload(before.stagedFiles),
      });
      expect(stagingRequests(retried)).toEqual(stagingRequests(before));
      await expect(page.getByTestId('chat-composer-input')).toHaveValue('');
    } finally {
      await closeElectronApp(app);
    }
  });
});
