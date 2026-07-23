import type { ToolDefinition } from '../core/llm.js';
import type { ToolResult, ToolContext } from './types.js';

// ── Definitions ──

export const browserOpenTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_open',
    description: 'Open a Playwright browser session and navigate to a URL. Returns a session_id for follow-up browser_click/browser_type/browser_extract/browser_assert calls.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target URL to open',
        },
        headless: {
          type: 'boolean',
          description: 'Whether to run headless browser (default: true)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Navigation timeout in milliseconds (default: 30000)',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
};

export const browserClickTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_click',
    description: 'Click an element in an active browser session. Primary path uses DOM selector; if it fails and hint is provided, tool falls back to vision-based coordinate click.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Browser session ID from browser_open',
        },
        selector: {
          type: 'string',
          description: 'DOM selector to click (preferred when known)',
        },
        hint: {
          type: 'string',
          description: 'Visible text or target hint for fallback location',
        },
        timeout_ms: {
          type: 'number',
          description: 'Action timeout in milliseconds (default: 10000)',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a high-risk action after /approve',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
};

export const browserTypeTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_type',
    description: 'Type text into an element in an active browser session. Uses DOM selector first; supports vision fallback via hint when DOM lookup fails.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Browser session ID from browser_open',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        selector: {
          type: 'string',
          description: 'DOM selector for input field',
        },
        hint: {
          type: 'string',
          description: 'Visible target hint for fallback click before typing',
        },
        clear: {
          type: 'boolean',
          description: 'Clear existing input value before typing (default: true)',
        },
        press_enter: {
          type: 'boolean',
          description: 'Press Enter after typing',
        },
        timeout_ms: {
          type: 'number',
          description: 'Action timeout in milliseconds (default: 10000)',
        },
        approval_request_id: {
          type: 'string',
          description: 'Required when retrying a high-risk action after /approve',
        },
      },
      required: ['session_id', 'text'],
      additionalProperties: false,
    },
  },
};

export const browserExtractTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_extract',
    description: 'Extract text or attribute from page content in an active browser session. Use selector for targeted extraction, or omit selector for body text.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Browser session ID from browser_open',
        },
        selector: {
          type: 'string',
          description: 'Optional DOM selector to extract from',
        },
        attribute: {
          type: 'string',
          description: 'Optional attribute name (if omitted, extracts inner text)',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000)',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
};

export const browserAssertTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_assert',
    description: 'Assert browser state/content in active session. Supports URL regex, selector existence, and text contains assertions.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Browser session ID from browser_open',
        },
        assertion: {
          type: 'string',
          enum: ['contains_text', 'url_matches', 'selector_exists'],
          description: 'Assertion type',
        },
        value: {
          type: 'string',
          description: 'Expected value (text or regex pattern depending on assertion type)',
        },
        selector: {
          type: 'string',
          description: 'Optional selector for contains_text/selector_exists assertions',
        },
      },
      required: ['session_id', 'assertion'],
      additionalProperties: false,
    },
  },
};

export const BROWSER_TOOLS: ToolDefinition[] = [
  browserOpenTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserAssertTool,
];

// ── Executor ──

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  id: string,
  context?: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'browser_open': {
      const url = args.url as string;
      const headless = args.headless as boolean | undefined;
      const timeoutMs = args.timeout_ms as number | undefined;
      if (!url || typeof url !== 'string') {
        return { tool_call_id: id, content: 'Error: "url" parameter is required and must be a string', is_error: true };
      }
      // SSRF protection
      const { checkSSRF } = await import('../security/ssrf-guard.js');
      const ssrfCheck = await checkSSRF(url);
      if (!ssrfCheck.safe) {
        return { tool_call_id: id, content: `Error: URL blocked by SSRF protection — ${ssrfCheck.reason}`, is_error: true };
      }

      if (headless !== undefined && typeof headless !== 'boolean') {
        return { tool_call_id: id, content: 'Error: "headless" must be a boolean', is_error: true };
      }
      if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
        return { tool_call_id: id, content: 'Error: "timeout_ms" must be a number', is_error: true };
      }
      const { openSession } = await import('../capabilities/browser.js');
      const result = await openSession({
        url,
        headless,
        timeoutMs,
        tenantId: context?.tenantId || 'default',
      });
      return {
        tool_call_id: id,
        content: `Browser session opened: ${result.sessionId}\nURL: ${result.url}\nTitle: ${result.title}`,
        is_error: false,
      };
    }

    case 'browser_click': {
      const sessionId = args.session_id as string;
      const selector = args.selector as string | undefined;
      const hint = args.hint as string | undefined;
      const timeoutMs = args.timeout_ms as number | undefined;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (!sessionId || typeof sessionId !== 'string') {
        return { tool_call_id: id, content: 'Error: "session_id" is required and must be a string', is_error: true };
      }
      if (selector !== undefined && typeof selector !== 'string') {
        return { tool_call_id: id, content: 'Error: "selector" must be a string', is_error: true };
      }
      if (hint !== undefined && typeof hint !== 'string') {
        return { tool_call_id: id, content: 'Error: "hint" must be a string', is_error: true };
      }
      if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
        return { tool_call_id: id, content: 'Error: "timeout_ms" must be a number', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { click: clickInBrowser } = await import('../capabilities/browser.js');
      const result = await clickInBrowser({
        sessionId,
        selector,
        hint,
        timeoutMs,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, content: result, is_error: false };
    }

    case 'browser_type': {
      const sessionId = args.session_id as string;
      const text = args.text as string;
      const selector = args.selector as string | undefined;
      const hint = args.hint as string | undefined;
      const clear = args.clear as boolean | undefined;
      const pressEnter = args.press_enter as boolean | undefined;
      const timeoutMs = args.timeout_ms as number | undefined;
      const approvalRequestId = args.approval_request_id as string | undefined;
      if (!sessionId || typeof sessionId !== 'string') {
        return { tool_call_id: id, content: 'Error: "session_id" is required and must be a string', is_error: true };
      }
      if (!text || typeof text !== 'string') {
        return { tool_call_id: id, content: 'Error: "text" is required and must be a string', is_error: true };
      }
      if (selector !== undefined && typeof selector !== 'string') {
        return { tool_call_id: id, content: 'Error: "selector" must be a string', is_error: true };
      }
      if (hint !== undefined && typeof hint !== 'string') {
        return { tool_call_id: id, content: 'Error: "hint" must be a string', is_error: true };
      }
      if (clear !== undefined && typeof clear !== 'boolean') {
        return { tool_call_id: id, content: 'Error: "clear" must be a boolean', is_error: true };
      }
      if (pressEnter !== undefined && typeof pressEnter !== 'boolean') {
        return { tool_call_id: id, content: 'Error: "press_enter" must be a boolean', is_error: true };
      }
      if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
        return { tool_call_id: id, content: 'Error: "timeout_ms" must be a number', is_error: true };
      }
      if (approvalRequestId !== undefined && typeof approvalRequestId !== 'string') {
        return { tool_call_id: id, content: 'Error: "approval_request_id" must be a string', is_error: true };
      }
      const { type: typeInBrowser } = await import('../capabilities/browser.js');
      const result = await typeInBrowser({
        sessionId,
        text,
        selector,
        hint,
        clear,
        pressEnter,
        timeoutMs,
        approvalRequestId,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, content: result, is_error: false };
    }

    case 'browser_extract': {
      const sessionId = args.session_id as string;
      const selector = args.selector as string | undefined;
      const attribute = args.attribute as string | undefined;
      const maxChars = args.max_chars as number | undefined;
      if (!sessionId || typeof sessionId !== 'string') {
        return { tool_call_id: id, content: 'Error: "session_id" is required and must be a string', is_error: true };
      }
      if (selector !== undefined && typeof selector !== 'string') {
        return { tool_call_id: id, content: 'Error: "selector" must be a string', is_error: true };
      }
      if (attribute !== undefined && typeof attribute !== 'string') {
        return { tool_call_id: id, content: 'Error: "attribute" must be a string', is_error: true };
      }
      if (maxChars !== undefined && typeof maxChars !== 'number') {
        return { tool_call_id: id, content: 'Error: "max_chars" must be a number', is_error: true };
      }
      const { extract: extractFromBrowser } = await import('../capabilities/browser.js');
      const result = await extractFromBrowser({
        sessionId,
        selector,
        attribute,
        maxChars,
        tenantId: context?.tenantId || 'default',
      });
      return { tool_call_id: id, content: result, is_error: false };
    }

    case 'browser_assert': {
      const sessionId = args.session_id as string;
      const assertion = args.assertion as 'contains_text' | 'url_matches' | 'selector_exists';
      const value = args.value as string | undefined;
      const selector = args.selector as string | undefined;
      if (!sessionId || typeof sessionId !== 'string') {
        return { tool_call_id: id, content: 'Error: "session_id" is required and must be a string', is_error: true };
      }
      if (!assertion || typeof assertion !== 'string') {
        return { tool_call_id: id, content: 'Error: "assertion" is required and must be a string', is_error: true };
      }
      if (value !== undefined && typeof value !== 'string') {
        return { tool_call_id: id, content: 'Error: "value" must be a string', is_error: true };
      }
      if (selector !== undefined && typeof selector !== 'string') {
        return { tool_call_id: id, content: 'Error: "selector" must be a string', is_error: true };
      }
      const { assert: assertInBrowser } = await import('../capabilities/browser.js');
      const result = await assertInBrowser({
        sessionId,
        assertion,
        value,
        selector,
        tenantId: context?.tenantId || 'default',
      });
      return {
        tool_call_id: id,
        content: result.detail,
        is_error: !result.passed,
      };
    }

    default:
      return null;
  }
}
