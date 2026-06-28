import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';

const PLUGIN_ID = 'uclaw-computer-use';
const DEFAULT_HOST_API_ORIGIN = 'http://127.0.0.1:13210';
const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};
const MOUSE_BUTTON_SCHEMA = {
  type: 'string',
  enum: ['left', 'right', 'middle'],
  description: 'Mouse button to click.',
};
const KEY_SCHEMA = {
  type: 'string',
  description: 'Keyboard key name, such as enter, escape, tab, space, left, right, a, f5.',
};
const MODIFIERS_SCHEMA = {
  type: 'array',
  items: {
    type: 'string',
    enum: ['ctrl', 'control', 'shift', 'alt', 'win', 'meta'],
  },
  description: 'Modifier keys held while pressing the key.',
};

function resolveHostApiOrigin() {
  return (process.env.CLAWX_HOST_API_ORIGIN || DEFAULT_HOST_API_ORIGIN).replace(/\/+$/u, '');
}

function resolveHostApiToken() {
  const token = process.env.CLAWX_HOST_API_TOKEN || '';
  if (!token.trim()) {
    throw new Error('UClaw Host API token is not available for computer-use tools');
  }
  return token;
}

async function hostApiFetch(path, options = {}) {
  const response = await fetch(`${resolveHostApiOrigin()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${resolveHostApiToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.success === false) {
    const message = payload?.error || `Host API request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function summarizeScreenshot(payload) {
  const screenshot = payload?.screenshot || payload?.result;
  if (!screenshot?.filePath) {
    return payload;
  }
  return {
    filePath: screenshot.filePath,
    mimeType: screenshot.mimeType || 'image/png',
    fileSize: screenshot.fileSize,
    sourceName: screenshot.sourceName,
    note: 'Desktop screenshot captured. Use filePath as the image artifact path when you need to inspect or attach it.',
  };
}

function resultOrPayload(payload) {
  return payload?.result || payload;
}

export const pluginEntry = defineToolPlugin({
  id: PLUGIN_ID,
  name: 'UClaw Computer Use',
  description: 'Local desktop screenshot, clipboard, window inspection, and basic mouse/keyboard tools provided by UClaw.',
  tools: (tool) => [
    tool({
      name: 'computer_screenshot',
      label: 'Capture desktop screenshot',
      description: 'Capture the current desktop screen and return the saved PNG file path. Use this when the user asks to see, inspect, or screenshot their current screen.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => summarizeScreenshot(await hostApiFetch('/api/computer/screenshot', {
        method: 'POST',
        body: '{}',
      })),
    }),
    tool({
      name: 'computer_clipboard_read',
      label: 'Read clipboard text',
      description: 'Read plain text from the local system clipboard.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => {
        const payload = await hostApiFetch('/api/computer/clipboard/read', {
          method: 'POST',
          body: '{}',
        });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_clipboard_write',
      label: 'Write clipboard text',
      description: 'Write plain text to the local system clipboard.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Text to write to the clipboard.',
          },
        },
      },
      execute: async ({ text }) => {
        const payload = await hostApiFetch('/api/computer/clipboard/write', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_window_list',
      label: 'List app windows',
      description: 'List UClaw/Electron application windows known to the local host, including title, bounds, focus, visible, and minimized state.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => {
        const payload = await hostApiFetch('/api/computer/windows', { method: 'GET' });
        return payload.result || payload;
      },
    }),
    tool({
      name: 'computer_window_sources',
      label: 'List capturable windows',
      description: 'List desktop windows that can be captured by UClaw, including source ids for window screenshots.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/window-sources', { method: 'GET' })),
    }),
    tool({
      name: 'computer_window_screenshot',
      label: 'Capture window screenshot',
      description: 'Capture a screenshot of an application window. Provide sourceId from computer_window_sources or titleIncludes to choose a window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceId: {
            type: 'string',
            description: 'Window source id returned by computer_window_sources.',
          },
          titleIncludes: {
            type: 'string',
            description: 'Fallback case-insensitive title substring to select a window.',
          },
        },
      },
      execute: async (params) => summarizeScreenshot(await hostApiFetch('/api/computer/window-screenshot', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_display_list',
      label: 'List displays',
      description: 'List local displays, bounds, work areas, and scale factors for coordinate-based computer control.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/displays', { method: 'GET' })),
    }),
    tool({
      name: 'computer_cursor_position',
      label: 'Get cursor position',
      description: 'Return the current global mouse cursor coordinates.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/cursor', { method: 'GET' })),
    }),
    tool({
      name: 'computer_mouse_move',
      label: 'Move mouse',
      description: 'Move the global mouse cursor to absolute screen coordinates. Use display bounds from computer_display_list when planning coordinates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number', description: 'Absolute screen X coordinate.' },
          y: { type: 'number', description: 'Absolute screen Y coordinate.' },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/move', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_click',
      label: 'Click mouse',
      description: 'Click the global mouse cursor. Optionally move to absolute x/y before clicking.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number', description: 'Optional absolute screen X coordinate.' },
          y: { type: 'number', description: 'Optional absolute screen Y coordinate.' },
          button: MOUSE_BUTTON_SCHEMA,
          clicks: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            description: 'Number of clicks, default 1.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/click', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_key_press',
      label: 'Press key',
      description: 'Press a keyboard key, optionally with modifiers such as ctrl, shift, alt, or win.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: {
          key: KEY_SCHEMA,
          modifiers: MODIFIERS_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/keyboard/press', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_type_text',
      label: 'Type text',
      description: 'Paste plain text into the currently focused app using the system clipboard followed by Ctrl+V.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'Plain text to paste into the currently focused app.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/keyboard/type', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
  ],
});

export default pluginEntry;
