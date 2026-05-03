import { chatCompletionResponse, chatCompletionToolCallResponse, createChatCompletionId, hasOpenAITooling, openaiError, streamChunk, toClaudeArgs, type ChatCompletionRequest, validateChatCompletionRequest } from "../openai-adapter.js";
import { ClaudeCliError } from "../errors.js";
import { debugEnabled } from "../env-policy.js";
import { traceEvent } from "../trace.js";
import type { OpenAIToolCallResult } from "../types.js";
import { DefaultClaudeClient, type ClaudeClient } from "./claude-client.js";

type ChatCompletionBody = ReturnType<typeof chatCompletionResponse> | ReturnType<typeof chatCompletionToolCallResponse>;

const streamToolCallsDelta = (toolCalls: readonly OpenAIToolCallResult[]) => toolCalls.map((toolCall, index) => ({ index, ...toolCall }));

const agentSdkFallbackRequest = (request: ChatCompletionRequest): ChatCompletionRequest => {
  return {
    ...request,
    enable_tools: true,
    claude: {
      ...request.claude,
      enableTools: true,
      toolMode: request.claude?.toolMode || "readonly",
    },
    messages: [
      {
        role: "developer",
        content:
          "This is an OpenAI-compatible server over Claude Code Agent SDK. When tools are provided, call them through the available OpenAI tool adapter. Never print internal protocol markup such as <delegation>, <function_calls>, or pseudo tool calls.",
      },
      ...(request.messages || []),
    ],
  };
};

export type WrapperResult =
  | { readonly ok: true; readonly status: number; readonly body: ChatCompletionBody }
  | { readonly ok: false; readonly status: number; readonly body: ReturnType<typeof openaiError>["body"] };

export type StreamChunkHandler = (chunk: ReturnType<typeof streamChunk>) => void;

const toOpenAIError = (error: unknown): ReturnType<typeof openaiError> => {
  if (error instanceof ClaudeCliError) {
    switch (error.code) {
      case "QUEUE_FULL":
      case "QUEUE_TIMEOUT":
        return openaiError(error.message, "rate_limit_error", 429);
      case "SESSION_LOCK_TIMEOUT":
        return openaiError(error.message, "conflict_error", 409);
      case "SERVER_SHUTTING_DOWN":
        return openaiError(error.message, "service_unavailable", 503);
      case "CLAUDE_TIMEOUT":
        return openaiError(error.message, "timeout_error", 504);
      case "CLAUDE_CANCELED":
        return openaiError(error.message, "request_canceled", 499);
      case "CLAUDE_NOT_FOUND":
        return openaiError(error.message, "configuration_error", 503);
      case "CLAUDE_OUTPUT_TOO_LARGE":
        return openaiError(error.message, "context_length_exceeded", 413);
      default:
        return openaiError(error.message, "claude_cli_error", 500);
    }
  }
  return openaiError(error instanceof Error ? error.message : String(error), "internal_error", 500);
};

export class CoreWrapper {
  constructor(private readonly client: ClaudeClient = new DefaultClaudeClient()) {}

  async executeChatCompletion(request: unknown, options: { readonly signal?: AbortSignal } = {}): Promise<WrapperResult> {
    const validatedRequest = validateChatCompletionRequest(request);
    if ("error" in validatedRequest) {
      return { ok: false, status: validatedRequest.error.status, body: validatedRequest.error.body };
    }
    const requestObj = validatedRequest;
    const effectiveRequest = hasOpenAITooling(requestObj) ? agentSdkFallbackRequest(requestObj) : requestObj;
    traceEvent("openai.request", requestObj, "debug");
    traceEvent("openai.effective_request", effectiveRequest, "debug");

    const claudeArgs = toClaudeArgs(effectiveRequest);
    traceEvent("adapter.claude_args", claudeArgs, "debug");
    if ("error" in claudeArgs) {
      return { ok: false, status: claudeArgs.error.status, body: claudeArgs.error.body };
    }
    try {
      const result = await this.client.execute(claudeArgs, { signal: options.signal });
      const id = createChatCompletionId();
      const model = requestObj.model || "claude";
      if (result.toolCalls?.length) {
        if (debugEnabled()) console.error(`[claude-openai] OpenAI tool_calls: ${JSON.stringify(result.toolCalls, null, 2)}`);
        traceEvent("openai.response.tool_calls", result.toolCalls, "debug");
        return { ok: true, status: 200, body: chatCompletionToolCallResponse(id, model, result.toolCalls, null) };
      }
      const response = chatCompletionResponse(id, model, result.text.trim());
      traceEvent("openai.response", response, "debug");
      return { ok: true, status: 200, body: response };
    } catch (error) {
      const failure = toOpenAIError(error);
      return { ok: false, status: failure.status, body: failure.body };
    }
  }

  async executeChatCompletionStreaming(
    request: unknown,
    onChunk: StreamChunkHandler,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly ok: true; readonly id: string; readonly model: string } | { readonly ok: false; readonly status: number; readonly body: ReturnType<typeof openaiError>["body"] }> {
    const validatedRequest = validateChatCompletionRequest(request);
    if ("error" in validatedRequest) {
      return { ok: false, status: validatedRequest.error.status, body: validatedRequest.error.body };
    }
    const requestObj = validatedRequest;
    const effectiveRequest = hasOpenAITooling(requestObj) ? agentSdkFallbackRequest(requestObj) : requestObj;
    traceEvent("openai.stream_request", requestObj, "debug");
    traceEvent("openai.stream_effective_request", effectiveRequest, "debug");

    const claudeArgs = toClaudeArgs(effectiveRequest);
    traceEvent("adapter.stream_claude_args", claudeArgs, "debug");
    if ("error" in claudeArgs) {
      return { ok: false, status: claudeArgs.error.status, body: claudeArgs.error.body };
    }

    const id = createChatCompletionId();
    const model = requestObj.model || "claude";
    let emittedAnyChunk = false;
    const emit = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
      if (!emittedAnyChunk) onChunk(streamChunk(id, model, { role: "assistant", content: "" }));
      emittedAnyChunk = true;
      onChunk(streamChunk(id, model, delta, finishReason));
    };
    let streamedText = false;

    try {
      const result = await this.client.executeStreaming(
        claudeArgs,
        {
          onText: (text) => {
            const clean = text;
            if (!clean) return;
            streamedText = true;
            emit({ content: clean });
          },
        },
        { signal: options.signal },
      );
      if (result.toolCalls?.length) {
        if (debugEnabled()) console.error(`[claude-openai] OpenAI stream tool_calls: ${JSON.stringify(result.toolCalls, null, 2)}`);
        traceEvent("openai.stream_tool_calls", result.toolCalls, "debug");
        emit({ tool_calls: streamToolCallsDelta(result.toolCalls) });
        onChunk(streamChunk(id, model, {}, "tool_calls"));
      } else {
        const text = result.text.trim();
        if (text && !streamedText) emit({ content: text });
        if (!emittedAnyChunk) onChunk(streamChunk(id, model, { role: "assistant", content: "" }));
        onChunk(streamChunk(id, model, {}, "stop"));
      }
      return { ok: true, id, model };
    } catch (error) {
      const failure = toOpenAIError(error);
      if (emittedAnyChunk) {
        // Stream already started – terminate cleanly; do not leak internal error into assistant content
        onChunk(streamChunk(id, model, {}, "stop"));
        return { ok: true, id, model };
      }
      return { ok: false, status: failure.status, body: failure.body };
    }
  }
}
