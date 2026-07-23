/**
 * Scripted E2E LLM Client — deterministic fake client for gate:e2e.
 *
 * Selected when MOZI_E2E_LLM=scripted. Zero network, zero cost.
 * This module is ONLY for CI gate testing; it has zero effect in production.
 *
 * Sequence:
 *   Turn 1 (foreground brain): returns decompose_task tool call
 *   Step LLM calls: returns one write_file tool call then a text completion
 *   Plan summary call: returns fixed summary text
 *
 * The client tracks call count to drive state transitions. This is intentionally
 * simple — the goal is to exercise the runtime seams, not the LLM.
 */

import type { LLMClient, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from './llm.js';

let _callCount = 0;

/** Reset call counter between tests. */
export function resetScriptedClientState(): void {
  _callCount = 0;
}

/** The scripted plan: 2 steps for the e2e gate. */
export const SCRIPTED_PLAN_GOAL = 'E2E Gate: write two test files';
export const SCRIPTED_PLAN = {
  goal: SCRIPTED_PLAN_GOAL,
  subtasks: [
    {
      title: 'Write file A',
      objective: 'Write /tmp/gate-a.txt with content "gate-a"',
      done_criteria: 'file exists',
      depends_on: [],
      agent_type_hint: 'any',
      constraints: {},
    },
    {
      title: 'Write file B',
      objective: 'Write /tmp/gate-b.txt with content "gate-b"',
      done_criteria: 'file exists',
      depends_on: [0],
      agent_type_hint: 'any',
      constraints: {},
    },
  ],
};

/** Build a deterministic ChatResponse for a given call number. */
function buildResponse(callNum: number): ChatResponse {
  const id = `scripted-${callNum}-${Date.now()}`;

  // Call 0: foreground brain turn — return decompose_task tool call
  if (callNum === 0) {
    return {
      content: 'Breaking this into a background plan.',
      tool_calls: [
        {
          id,
          type: 'function',
          function: {
            name: 'decompose_task',
            arguments: JSON.stringify(SCRIPTED_PLAN),
          },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
      model: 'scripted',
      stop_reason: 'tool_calls',
    };
  }

  // Calls 1-4: step execution — alternate between tool call and completion
  // Odd calls: return a write_file tool call
  if (callNum % 2 === 1) {
    return {
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: `/tmp/gate-e2e-${callNum}.txt`,
              content: `e2e gate step ${callNum}`,
            }),
          },
        },
      ],
      usage: { input_tokens: 15, output_tokens: 8 },
      model: 'scripted',
      stop_reason: 'tool_calls',
    };
  }

  // Even calls (not 0): completion text for the step
  return {
    content: `Step ${callNum} complete. File written successfully.`,
    usage: { input_tokens: 12, output_tokens: 6 },
    model: 'scripted',
    stop_reason: 'end_turn',
  };
}

/** Build the scripted e2e LLM client. */
export function createScriptedE2EClient(): LLMClient {
  return {
    provider: 'scripted',

    async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
      const callNum = _callCount++;
      return buildResponse(callNum);
    },

    async *chatStream(_messages: ChatMessage[], _options?: ChatOptions): AsyncGenerator<StreamChunk> {
      const callNum = _callCount++;
      const response = buildResponse(callNum);

      // Emit text chunk if any content
      if (response.content) {
        yield { type: 'text', text: response.content };
      }

      // Emit tool call chunks if any
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const tc of response.tool_calls) {
          const callId = tc.id;
          yield { type: 'tool_input_start', toolCallId: callId, toolName: tc.function.name };
          yield { type: 'tool_input_delta', toolCallId: callId, delta: tc.function.arguments };
          yield { type: 'tool_input_end', toolCallId: callId };
        }
      }

      yield { type: 'done', response };
    },
  };
}
