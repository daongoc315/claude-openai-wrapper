import { toClaudeArgs } from "../openai-adapter.js";
import { DefaultClaudeClient, type ClaudeClient } from "./claude-client.js";
import { chatCompletionResponse, createChatCompletionId, openaiError, streamChunk, type ChatCompletionRequest } from "./response-validator.js";

export type WrapperResult =
  | { readonly ok: true; readonly status: number; readonly body: ReturnType<typeof chatCompletionResponse> }
  | { readonly ok: false; readonly status: number; readonly body: ReturnType<typeof openaiError>["body"] };

export type StreamChunkHandler = (chunk: ReturnType<typeof streamChunk>) => void;

export class CoreWrapper {
  constructor(private readonly client: ClaudeClient = new DefaultClaudeClient()) {}

  async executeChatCompletion(request: ChatCompletionRequest, options: { readonly signal?: AbortSignal } = {}): Promise<WrapperResult> {
    const claudeArgs = toClaudeArgs(request);
    if ("error" in claudeArgs) {
      return { ok: false, status: claudeArgs.error.status, body: claudeArgs.error.body };
    }
    try {
      const result = await this.client.execute(claudeArgs, { signal: options.signal });
      const id = createChatCompletionId();
      const model = request.model || "claude";
      return { ok: true, status: 200, body: chatCompletionResponse(id, model, result.text) };
    } catch (error) {
      const failure = openaiError(error instanceof Error ? error.message : String(error), "claude_cli_error", 500);
      return { ok: false, status: failure.status, body: failure.body };
    }
  }

  async executeChatCompletionStreaming(
    request: ChatCompletionRequest,
    onChunk: StreamChunkHandler,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly ok: true; readonly id: string; readonly model: string } | { readonly ok: false; readonly status: number; readonly body: ReturnType<typeof openaiError>["body"] }> {
    const claudeArgs = toClaudeArgs(request);
    if ("error" in claudeArgs) {
      return { ok: false, status: claudeArgs.error.status, body: claudeArgs.error.body };
    }
    const id = createChatCompletionId();
    const model = request.model || "claude";
    onChunk(streamChunk(id, model, { role: "assistant", content: "" }));
    try {
      await this.client.executeStreaming(
        claudeArgs,
        {
          onText: (text) => {
            onChunk(streamChunk(id, model, { content: text }));
          },
        },
        { signal: options.signal },
      );
      onChunk(streamChunk(id, model, {}, "stop"));
      return { ok: true, id, model };
    } catch (error) {
      const failure = openaiError(error instanceof Error ? error.message : String(error), "claude_cli_error", 500);
      return { ok: false, status: failure.status, body: failure.body };
    }
  }
}
