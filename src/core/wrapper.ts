import { chatCompletionResponse, chatCompletionToolCallResponse, createChatCompletionId, hasOpenAITooling, openaiError, streamChunk, toClaudeArgs, type ChatCompletionRequest, validateChatCompletionRequest } from "../openai-adapter.js";
import { ClaudeCliError } from "../errors.js";
import { debugEnabled } from "../env-policy.js";
import { traceEvent } from "../trace.js";
import type { OpenAIToolCallResult } from "../types.js";
import { DefaultClaudeClient, type ClaudeClient } from "./claude-client.js";

type ChatCompletionBody = ReturnType<typeof chatCompletionResponse> | ReturnType<typeof chatCompletionToolCallResponse>;

const streamToolCallsDelta = (toolCalls: readonly OpenAIToolCallResult[]) => toolCalls.map((toolCall, index) => ({ index, ...toolCall }));

const agentSdkFallbackRequest = (request: ChatCompletionRequest): ChatCompletionRequest => ({
  ...request,
  enable_tools: true,
  claude: {
    ...request.claude,
    enableTools: true,
    toolMode: request.claude?.toolMode || "readonly",
  },
});

const requestSummary = (request: ChatCompletionRequest): Record<string, unknown> => ({
  model: request.model,
  stream: request.stream,
  messageCount: request.messages?.length ?? 0,
  toolCount: request.tools?.length ?? 0,
  hasSessionId: Boolean(request.session_id || request.claude?.sessionId),
  hasClaudeOptions: Boolean(request.claude && Object.keys(request.claude).length),
  enableTools: request.enable_tools || request.claude?.enableTools,
  toolChoice: request.tool_choice === undefined ? undefined : typeof request.tool_choice === "string" ? request.tool_choice : "object",
});

const claudeArgsSummary = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || "error" in value) return value;
  const args = value as {
    prompt?: string;
    sessionId?: string;
    model?: string;
    enableTools?: boolean;
    tools?: readonly unknown[];
    allowedTools?: readonly unknown[];
    disallowedTools?: readonly unknown[];
    openAITools?: readonly unknown[];
    permissionMode?: string;
    toolMode?: string;
    workingDirectory?: string;
  };
  return {
    model: args.model,
    sessionId: args.sessionId,
    promptChars: args.prompt?.length ?? 0,
    enableTools: args.enableTools,
    toolMode: args.toolMode,
    permissionMode: args.permissionMode,
    workingDirectory: args.workingDirectory,
    toolsCount: args.tools?.length ?? 0,
    allowedToolsCount: args.allowedTools?.length ?? 0,
    disallowedToolsCount: args.disallowedTools?.length ?? 0,
    openAIToolsCount: args.openAITools?.length ?? 0,
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
    traceEvent("openai.request_summary", requestSummary(requestObj), "debug");
    traceEvent("openai.effective_request_summary", requestSummary(effectiveRequest), "debug");
    traceEvent("openai.request", requestObj, "trace");
    traceEvent("openai.effective_request", effectiveRequest, "trace");

    const claudeArgs = toClaudeArgs(effectiveRequest);
    traceEvent("adapter.claude_args_summary", claudeArgsSummary(claudeArgs), "debug");
    traceEvent("adapter.claude_args", claudeArgs, "trace");
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
    traceEvent("openai.stream_request_summary", requestSummary(requestObj), "debug");
    traceEvent("openai.stream_effective_request_summary", requestSummary(effectiveRequest), "debug");
    traceEvent("openai.stream_request", requestObj, "trace");
    traceEvent("openai.stream_effective_request", effectiveRequest, "trace");

    const claudeArgs = toClaudeArgs(effectiveRequest);
    traceEvent("adapter.stream_claude_args_summary", claudeArgsSummary(claudeArgs), "debug");
    traceEvent("adapter.stream_claude_args", claudeArgs, "trace");
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
