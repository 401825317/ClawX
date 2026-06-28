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
const WINDOW_ACTION_SCHEMA = {
  type: 'string',
  enum: ['focus', 'restore', 'minimize', 'maximize', 'close'],
  description: 'Window action to perform.',
};
const WINDOW_TARGET_PROPERTIES = {
  hwnd: {
    type: 'number',
    description: 'Window handle returned by computer_system_window_list.',
  },
  titleIncludes: {
    type: 'string',
    description: 'Fallback case-insensitive title substring to find a window.',
  },
};
const BROWSER_TARGET_PROPERTIES = {
  windowId: {
    type: 'integer',
    description: 'Optional Electron BrowserWindow id returned by computer_window_list. Defaults to the main UClaw window.',
  },
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

function summarizeInspection(payload) {
  const result = payload?.result || payload;
  const screenshot = result?.screenshot;
  return {
    screenshot: screenshot
      ? {
        filePath: screenshot.filePath,
        mimeType: screenshot.mimeType || 'image/png',
        fileSize: screenshot.fileSize,
        sourceName: screenshot.sourceName,
      }
      : null,
    ocr: result?.ocr || {
      supported: false,
      text: '',
      blocks: [],
      reason: 'No OCR result returned.',
    },
    note: 'Use the screenshot filePath with a vision-capable model if OCR.supported is false or OCR text is insufficient.',
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
      name: 'computer_inspect_screen',
      label: 'Inspect screen',
      description: 'Capture the desktop or a window and return a screenshot artifact plus OCR status. If OCR is unsupported, use the returned screenshot file path with a vision-capable model.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            enum: ['desktop', 'window'],
            description: 'Whether to inspect the full desktop or a specific application window. Defaults to desktop.',
          },
          sourceId: {
            type: 'string',
            description: 'Window source id returned by computer_window_sources when target is window.',
          },
          titleIncludes: {
            type: 'string',
            description: 'Fallback case-insensitive title substring for window inspection.',
          },
        },
      },
      execute: async (params) => summarizeInspection(await hostApiFetch('/api/computer/inspect', {
        method: 'POST',
        body: JSON.stringify(params || {}),
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
      name: 'computer_system_window_list',
      label: 'List system windows',
      description: 'List normal Windows desktop application windows by title/process, including hwnd, title, process, visible/minimized state, and bounds.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titleIncludes: {
            type: 'string',
            description: 'Optional case-insensitive title substring filter.',
          },
          processName: {
            type: 'string',
            description: 'Optional process name filter, for example chrome or notepad.',
          },
          visibleOnly: {
            type: 'boolean',
            description: 'Whether to include only visible windows. Defaults to true.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum number of windows to return. Defaults to 80.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-windows', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_control',
      label: 'Control system window',
      description: 'Focus, restore, minimize, maximize, or close a Windows desktop application window. Prefer hwnd from computer_system_window_list; titleIncludes is a fallback.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          action: WINDOW_ACTION_SCHEMA,
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/control', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_foreground',
      label: 'Get foreground window',
      description: 'Return the current foreground Windows desktop application window.',
      parameters: EMPTY_OBJECT_SCHEMA,
      execute: async () => resultOrPayload(await hostApiFetch('/api/computer/system-window/foreground', { method: 'GET' })),
    }),
    tool({
      name: 'computer_system_window_set_bounds',
      label: 'Set system window bounds',
      description: 'Move and/or resize a Windows desktop application window. Provide hwnd from computer_system_window_list when possible.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          x: { type: 'number', description: 'New left coordinate. Must be provided with y.' },
          y: { type: 'number', description: 'New top coordinate. Must be provided with x.' },
          width: { type: 'number', description: 'New window width. Must be provided with height.' },
          height: { type: 'number', description: 'New window height. Must be provided with width.' },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/bounds', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_system_window_set_topmost',
      label: 'Set system window topmost',
      description: 'Set or clear always-on-top for a Windows desktop application window.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          topmost: {
            type: 'boolean',
            description: 'true to keep window on top, false to clear topmost. Defaults to true.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/system-window/topmost', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_uia_tree',
      label: 'Get UI Automation tree',
      description: 'Read the Windows UI Automation control tree for the foreground or selected window, including control type, name, automation id, enabled/offscreen state, bounds, and children.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          maxDepth: {
            type: 'integer',
            minimum: 0,
            maximum: 6,
            description: 'Maximum UIA tree depth. Defaults to 4.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Maximum nodes to return. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/uia/tree', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_uia_find',
      label: 'Find UI Automation elements',
      description: 'Find controls in a Windows UI Automation tree by visible text/name, automation id, and/or control type. Returned bounds can be used with mouse tools.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...WINDOW_TARGET_PROPERTIES,
          textIncludes: {
            type: 'string',
            description: 'Case-insensitive text/name/automation id substring to match.',
          },
          controlType: {
            type: 'string',
            description: 'Control type substring such as button, edit, list, menuitem, document.',
          },
          maxDepth: {
            type: 'integer',
            minimum: 0,
            maximum: 6,
            description: 'Maximum UIA tree depth. Defaults to 4.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Maximum nodes to scan. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/uia/find', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_snapshot',
      label: 'Inspect browser DOM',
      description: 'Inspect the DOM of the UClaw browser window and return visible interactive elements with selectors, text, roles, and bounds.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'Optional CSS selector filter.',
          },
          textIncludes: {
            type: 'string',
            description: 'Optional case-insensitive text, label, id, role, placeholder, or href substring filter.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 800,
            description: 'Maximum DOM nodes to return. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/dom', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_find',
      label: 'Find browser DOM elements',
      description: 'Find DOM elements in the UClaw browser window by CSS selector or text/label substring. Use returned selector or index for DOM actions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'Optional CSS selector.',
          },
          textIncludes: {
            type: 'string',
            description: 'Optional case-insensitive text, label, id, role, placeholder, or href substring.',
          },
          maxNodes: {
            type: 'integer',
            minimum: 1,
            maximum: 800,
            description: 'Maximum DOM nodes to scan. Defaults to 200.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/find', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_browser_dom_action',
      label: 'Act on browser DOM',
      description: 'Focus, click, or type into a DOM element in the UClaw browser window. Mutating actions may return requiresConfirmation unless confirmed is true.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BROWSER_TARGET_PROPERTIES,
          selector: {
            type: 'string',
            description: 'CSS selector for the target element.',
          },
          index: {
            type: 'integer',
            minimum: 0,
            description: 'Index from computer_browser_dom_find when selector is not provided.',
          },
          textIncludes: {
            type: 'string',
            description: 'Text filter used with index lookup when selector is not provided.',
          },
          action: {
            type: 'string',
            enum: ['focus', 'click', 'type'],
            description: 'DOM action to perform.',
          },
          text: {
            type: 'string',
            description: 'Text to set when action is type.',
          },
          confirmed: {
            type: 'boolean',
            description: 'Set true after user confirmation for mutating or risky actions.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/browser/action', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_safety_evaluate',
      label: 'Evaluate computer action risk',
      description: 'Evaluate whether a computer-use action is read-only, mutating, or potentially destructive/transactional before executing it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            description: 'Action identifier such as browserClick, browserType, mouseClick, typeText, windowClose, observe.',
          },
          target: {
            type: 'string',
            description: 'Human-readable target text or selector for risk scanning.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/safety/evaluate', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_agent_run_steps',
      label: 'Run computer-use steps',
      description: 'Run a short deterministic observe/act loop for computer-use tasks. Supported step actions: observeDom, findDom, focusDom, clickDom, typeDom, screenshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['goal'],
        properties: {
          goal: {
            type: 'string',
            description: 'User goal for the computer-use loop.',
          },
          steps: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: true,
            },
            description: 'Deterministic steps to run. The model should inspect results and continue or finish.',
          },
          confirmed: {
            type: 'boolean',
            description: 'Set true only after user confirmation for mutating or risky steps.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/agent/run', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
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
      name: 'computer_mouse_button',
      label: 'Mouse button down/up',
      description: 'Press or release a mouse button without automatically releasing or pressing it. Useful for custom drag operations.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          button: MOUSE_BUTTON_SCHEMA,
          action: {
            type: 'string',
            enum: ['down', 'up'],
            description: 'Whether to press or release the button.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/button', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_scroll',
      label: 'Scroll mouse wheel',
      description: 'Scroll the mouse wheel. Negative delta scrolls down; positive delta scrolls up. Optionally move to x/y first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delta: {
            type: 'number',
            description: 'Wheel delta. Typical one-notch values are -120 or 120. Defaults to -120.',
          },
          x: { type: 'number', description: 'Optional absolute screen X coordinate.' },
          y: { type: 'number', description: 'Optional absolute screen Y coordinate.' },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/scroll', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
    tool({
      name: 'computer_mouse_drag',
      label: 'Drag mouse',
      description: 'Drag from one absolute screen coordinate to another using a mouse button.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fromX', 'fromY', 'toX', 'toY'],
        properties: {
          fromX: { type: 'number', description: 'Start X coordinate.' },
          fromY: { type: 'number', description: 'Start Y coordinate.' },
          toX: { type: 'number', description: 'End X coordinate.' },
          toY: { type: 'number', description: 'End Y coordinate.' },
          button: MOUSE_BUTTON_SCHEMA,
          durationMs: {
            type: 'number',
            description: 'Drag duration in milliseconds. Defaults to 350.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/mouse/drag', {
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
    tool({
      name: 'computer_file_dialog_set_path',
      label: 'Set file dialog path',
      description: 'Paste a file path into the currently focused system file picker and optionally press Enter. Use after opening a file upload/save dialog.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['filePath'],
        properties: {
          filePath: {
            type: 'string',
            description: 'Absolute file path to paste into the focused file dialog.',
          },
          submit: {
            type: 'boolean',
            description: 'Whether to press Enter after pasting. Defaults to true.',
          },
        },
      },
      execute: async (params) => resultOrPayload(await hostApiFetch('/api/computer/file-dialog/set-path', {
        method: 'POST',
        body: JSON.stringify(params || {}),
      })),
    }),
  ],
});

export default pluginEntry;
