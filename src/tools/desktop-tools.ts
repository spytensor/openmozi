import type { ToolDefinition } from '../core/llm.js';
import type { ToolContext, ToolResult } from './types.js';

export const desktopScreenshotTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_screenshot',
    description: 'Capture a screenshot of the current desktop and return the image path. Use before visual desktop actions or when you need to inspect non-browser UI.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional output file path. If omitted, MOZI creates a temp PNG path.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const desktopListWindowsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_list_windows',
    description: 'List visible desktop windows or desktop-controllable app surfaces. Use this before focusing a specific window.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};

export const desktopFocusWindowTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_focus_window',
    description: 'Focus a desktop window by window_id or title/app name.',
    parameters: {
      type: 'object',
      properties: {
        window_id: {
          type: 'string',
          description: 'Window identifier returned by desktop_list_windows',
        },
        title: {
          type: 'string',
          description: 'Window title or app name to focus',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

export const desktopLaunchAppTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_launch_app',
    description: 'Launch a desktop application or GUI command in detached mode. When desktop_control hard gate is enabled, approval is required.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Executable or app command to launch',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional argument list',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated desktop launch after /approve',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const desktopClickTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_click',
    description: 'Click at desktop coordinates. Use desktop_screenshot + vision analysis first if you do not already know the target coordinates.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in screen pixels' },
        y: { type: 'number', description: 'Y coordinate in screen pixels' },
        button: { type: 'number', description: 'Mouse button (default 1)' },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated click after /approve',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
};

export const desktopTypeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_type',
    description: 'Type text into the currently focused desktop window. Use desktop_focus_window first when needed.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type into the focused desktop surface' },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated desktop typing action after /approve',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
};

export const desktopHotkeyTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_hotkey',
    description: 'Press a desktop hotkey on the currently focused window, for example ["ctrl","l"] or ["alt","tab"].',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered key chord parts',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated desktop hotkey after /approve',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
};

export const desktopClickHintTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_click_hint',
    description: 'Click a desktop target by visual description instead of raw coordinates. The runtime captures a screenshot, asks a vision model to locate the target, then clicks its center.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Visible target description, such as button text or UI label',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated desktop click after /approve',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
};

export const desktopTypeHintTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'desktop_type_hint',
    description: 'Focus a desktop target by visual description and type into it. The runtime captures a screenshot, locates the target, clicks it, then types.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Visible target description, such as field label or placeholder text',
        },
        text: {
          type: 'string',
          description: 'Text to type after focusing the target',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a gated action after /approve',
        },
      },
      required: ['target', 'text'],
      additionalProperties: false,
    },
  },
};

export const DESKTOP_TOOLS: ToolDefinition[] = [
  desktopScreenshotTool,
  desktopListWindowsTool,
  desktopFocusWindowTool,
  desktopLaunchAppTool,
  desktopClickTool,
  desktopTypeTool,
  desktopHotkeyTool,
  desktopClickHintTool,
  desktopTypeHintTool,
];

export async function executeDesktopTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'desktop_screenshot': {
      const path = args.path as string | undefined;
      if (path !== undefined && typeof path !== 'string') {
        return { tool_call_id: id, content: 'Error: "path" must be a string', is_error: true };
      }
      const { takeDesktopScreenshot } = await import('../capabilities/desktop.js');
      const result = await takeDesktopScreenshot({ path });
      return {
        tool_call_id: id,
        tool_name: 'desktop_screenshot',
        content: `Desktop screenshot captured: ${result.path}`,
        file_path: result.path,
        is_error: false,
      };
    }

    case 'desktop_list_windows': {
      const { listDesktopWindows } = await import('../capabilities/desktop.js');
      const result = await listDesktopWindows();
      return {
        tool_call_id: id,
        tool_name: 'desktop_list_windows',
        content: JSON.stringify(result, null, 2),
        is_error: false,
      };
    }

    case 'desktop_focus_window': {
      const windowId = args.window_id as string | undefined;
      const title = args.title as string | undefined;
      if (windowId !== undefined && typeof windowId !== 'string') {
        return { tool_call_id: id, content: 'Error: "window_id" must be a string', is_error: true };
      }
      if (title !== undefined && typeof title !== 'string') {
        return { tool_call_id: id, content: 'Error: "title" must be a string', is_error: true };
      }
      if (!windowId && !title) {
        return { tool_call_id: id, content: 'Error: either "window_id" or "title" is required', is_error: true };
      }
      const { focusDesktopWindow } = await import('../capabilities/desktop.js');
      const result = await focusDesktopWindow({ windowId, title });
      return { tool_call_id: id, tool_name: 'desktop_focus_window', content: result, is_error: false };
    }

    case 'desktop_launch_app': {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      const approvalRequestId = args.approval_request_id as string | undefined;
      const rawArgs = args.args;
      if (!command || typeof command !== 'string') {
        return { tool_call_id: id, content: 'Error: "command" is required and must be a string', is_error: true };
      }
      if (cwd !== undefined && typeof cwd !== 'string') {
        return { tool_call_id: id, content: 'Error: "cwd" must be a string', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((value) => typeof value !== 'string'))) {
        return { tool_call_id: id, content: 'Error: "args" must be an array of strings', is_error: true };
      }
      const { launchDesktopApp } = await import('../capabilities/desktop.js');
      const result = await launchDesktopApp({
        command,
        args: rawArgs as string[] | undefined,
        cwd,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return {
        tool_call_id: id,
        tool_name: 'desktop_launch_app',
        content: `Desktop app launched: ${result.command} (pid=${result.pid ?? 'unknown'})`,
        is_error: false,
      };
    }

    case 'desktop_click': {
      const x = args.x as number;
      const y = args.y as number;
      const button = args.button as number | undefined;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (typeof x !== 'number' || typeof y !== 'number') {
        return { tool_call_id: id, content: 'Error: "x" and "y" must be numbers', is_error: true };
      }
      if (button !== undefined && typeof button !== 'number') {
        return { tool_call_id: id, content: 'Error: "button" must be a number', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { desktopClick } = await import('../capabilities/desktop.js');
      const result = await desktopClick({
        x,
        y,
        button,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, tool_name: 'desktop_click', content: result, is_error: false };
    }

    case 'desktop_type': {
      const text = args.text as string;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (typeof text !== 'string' || text.length === 0) {
        return { tool_call_id: id, content: 'Error: "text" is required and must be a non-empty string', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { desktopTypeText } = await import('../capabilities/desktop.js');
      const result = await desktopTypeText({
        text,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, tool_name: 'desktop_type', content: result, is_error: false };
    }

    case 'desktop_hotkey': {
      const rawKeys = args.keys;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.some((value) => typeof value !== 'string')) {
        return { tool_call_id: id, content: 'Error: "keys" must be a non-empty array of strings', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { desktopPressHotkey } = await import('../capabilities/desktop.js');
      const result = await desktopPressHotkey({
        keys: rawKeys as string[],
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, tool_name: 'desktop_hotkey', content: result, is_error: false };
    }

    case 'desktop_click_hint': {
      const target = args.target as string;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (typeof target !== 'string' || target.trim().length === 0) {
        return { tool_call_id: id, content: 'Error: "target" is required and must be a non-empty string', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { clickDesktopTarget } = await import('../capabilities/computer-use.js');
      const result = await clickDesktopTarget({
        target,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, tool_name: 'desktop_click_hint', content: result, is_error: false };
    }

    case 'desktop_type_hint': {
      const target = args.target as string;
      const text = args.text as string;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (typeof target !== 'string' || target.trim().length === 0) {
        return { tool_call_id: id, content: 'Error: "target" is required and must be a non-empty string', is_error: true };
      }
      if (typeof text !== 'string' || text.length === 0) {
        return { tool_call_id: id, content: 'Error: "text" is required and must be a non-empty string', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { typeIntoDesktopTarget } = await import('../capabilities/computer-use.js');
      const result = await typeIntoDesktopTarget({
        target,
        text,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, tool_name: 'desktop_type_hint', content: result, is_error: false };
    }

    default:
      return null;
  }
}
