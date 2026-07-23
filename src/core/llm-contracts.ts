import { generateText } from 'ai';

/** OpenAI function calling tool definition */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;  // JSON Schema
  };
}

/** Tool call returned by the LLM */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Multimodal content parts for user messages with images */
export type TextContentPart = { type: 'text'; text: string };
export type ImageContentPart = { type: 'image'; image: Buffer | Uint8Array; mediaType: string };
export type ContentPart = TextContentPart | ImageContentPart;

/** Standard message format for LLM chat */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Plain string for text-only messages, ContentPart[] for multimodal (images + text). */
  content: string | ContentPart[];
  /** Provider reasoning content that must be preserved for reasoning+tool-call turns. */
  reasoning_content?: string;
  /** Tool calls made by the assistant */
  tool_calls?: ToolCall[];
  /** Tool call ID this message is responding to (role=tool) */
  tool_call_id?: string;
  /** Tool name this result is for (role=tool, required by AI SDK v6) */
  tool_name?: string;
}

/** Extract text content from a ChatMessage regardless of content format. */
export function getTextContent(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((p): p is TextContentPart => p.type === 'text')
    .map(p => p.text)
    .join('\n');
}

export type ModelThinkSetting = boolean | 'low' | 'medium' | 'high' | number;

/** Options for chat completion */
export interface ChatOptions {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  /** Optional reasoning depth/budget hint (provider-specific best effort). */
  think?: ModelThinkSetting;
  stream?: boolean;
  /** Optional hard timeout for a single provider call in milliseconds (0 = disabled). */
  timeout_ms?: number;
  /** Internal timeout policy scope; interactive caps CLI-pipe calls for realtime turns. */
  execution_scope?: 'interactive' | 'worker' | 'background';
  /** Optional caller-provided cancellation signal (e.g., /cancel). */
  abort_signal?: AbortSignal;
  /** Tool definitions for function calling */
  tools?: ToolDefinition[];
  /** AI SDK tools from MCP bridge (already in CoreTool format, keyed by prefixed name) */
  mcpTools?: Record<string, unknown>;
  /** Key for CLI session tracking (e.g., chatId). Only used by cli-pipe providers. */
  cliSessionKey?: string;
  /** Internal billing metadata injected by model-router/turn execution. */
  billing?: {
    tenantId: string;
    userId?: string;
    taskId?: string;
    agentId?: string;
  };
  /** Turn-scoped usage sink: receives per-call token usage (including provider
   *  cache reads) so the caller can aggregate a whole turn without threading
   *  counters through every loop iteration. Must never throw. */
  usageCollector?: {
    add: (usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number }) => void;
  };
  /** Internal entitlement metadata used by provider failover. */
  entitlements?: {
    tenantId: string;
    userId: string;
    allowedModels?: string[] | null;
  };
  /** Keep one provider/model for the lifetime of a stateful tool loop. A
   * provider switch in the middle of that loop can invalidate provider-native
   * reasoning/tool-call history. Callers should use a fresh key when they
   * restart the task from its durable input. */
  failoverSessionKey?: string;
  /** Stable provider cache routing key for requests sharing the same immutable
   * prompt prefix. Currently consumed by the OpenAI adapter. */
  promptCacheKey?: string;
}

/** Response from LLM chat */
export interface ChatResponse {
  content: string;
  /** Provider reasoning content, used for APIs that require it in tool-call continuation turns. */
  reasoning_content?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Prompt tokens the provider served from its cache (Anthropic cache_read,
     *  OpenAI cached prompt tokens). Undefined when the provider does not report it. */
    cache_read_tokens?: number;
    /** Prompt tokens written into provider-managed cache. */
    cache_write_tokens?: number;
  };
  model: string;
  stop_reason: string | null;
  /** True when the provider stream ended before a complete response contract was observed. */
  incomplete?: boolean;
  /** True when response text may be a prefix of the intended model output. */
  truncated?: boolean;
  /** Runtime-visible reason for incomplete/truncated output. */
  incomplete_reason?: string;
  /** Whether usage came from the provider or is unavailable for this incomplete response. */
  usage_status?: 'reported' | 'unavailable';
  /** Tool calls requested by the model */
  tool_calls?: ToolCall[];
}

export class IncompleteStreamError extends Error {
  public readonly partialResponse: ChatResponse;
  public readonly cause?: unknown;

  constructor(message: string, partialResponse: ChatResponse, cause?: unknown) {
    super(message);
    this.name = 'IncompleteStreamError';
    this.partialResponse = partialResponse;
    this.cause = cause;
  }
}

/** Stream chunk from LLM */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_input_start'; toolCallId: string; toolName: string }
  | { type: 'tool_input_delta'; toolCallId: string; delta: string }
  | { type: 'tool_input_end'; toolCallId: string }
  | { type: 'done'; response: ChatResponse };

/** Unified LLM client interface */
export interface LLMClient {
  provider: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<StreamChunk>;
  /** Get the raw AI SDK LanguageModel for direct use with generateText/streamText. Only available for AI SDK adapters. */
  getAIModel?: (modelId?: string) => Parameters<typeof generateText>[0]['model'];
}

// ---------------------------------------------------------------------------
// Message conversion: MOZI ChatMessage[] → AI SDK CoreMessage[]
// ---------------------------------------------------------------------------
