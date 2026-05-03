import { randomUUID } from "node:crypto";
import { appConfig } from "./config.js";
import { traceEvent } from "./trace.js";
import type { ClaudeArgs } from "./schemas.js";

type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

export interface ChatMessage {
  readonly role?: ChatRole | string;
  readonly content?: unknown;
  readonly name?: string;
}

export interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly session_id?: string;
  readonly user?: string;
  readonly enable_tools?: boolean;
  readonly tool_choice?: unknown;
  readonly tools?: readonly unknown[];
  readonly claude?: Partial<ClaudeArgs>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

type OpenAIToolChoice = "auto" | "none" | { readonly type: "function"; readonly function: { readonly name: string } };

type ResolvedToolStrategy =
  | { readonly kind: "disabled" }
  | { readonly kind: "claudeExplicit"; readonly tools?: readonly string[]; readonly allowedTools?: readonly string[]; readonly disallowedTools?: readonly string[]; readonly enableTools?: boolean; readonly toolMode?: ClaudeArgs["toolMode"] }
  | { readonly kind: "openaiAdapter"; readonly tools: readonly unknown[]; readonly choice: OpenAIToolChoice }
  | { readonly kind: "claudeMode"; readonly mode: "readonly" | "safe" | "all" };

export interface OpenAIResponseToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export const hasOpenAITooling = (request: ChatCompletionRequest): boolean => Boolean(request.tools?.length);

export const DEFAULT_READONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
export const DEFAULT_SAFE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;
export const DANGEROUS_TOOLS = ["Bash", "NotebookEdit"] as const;

export const openaiError = (message: string, type = "invalid_request_error", status = 400) => ({
  status,
  body: {
    error: {
      message,
      type,
      code: null,
    },
  },
});

export const validateChatCompletionRequest = (input: unknown): ChatCompletionRequest | { readonly error: ReturnType<typeof openaiError> } => {
  if (!isRecord(input)) return { error: openaiError("request body must be an object") };

  const request = input as ChatCompletionRequest;

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: openaiError("messages must be a non-empty array") };
  }
  if (request.messages.length > 200) return { error: openaiError("messages must contain at most 200 items") };

  for (const message of request.messages) {
    if (!isRecord(message)) return { error: openaiError("each message must be an object") };
    if (message.role !== undefined && typeof message.role !== "string") return { error: openaiError("message.role must be a string") };
    if (message.content !== undefined && message.content !== null && typeof message.content !== "string" && !Array.isArray(message.content)) {
      return { error: openaiError("message.content must be a string, null, or an array") };
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part !== "string" && !isRecord(part)) {
          return { error: openaiError("message.content array parts must be strings or objects") };
        }
      }
    }
  }

  const promptBytes = Buffer.byteLength(messagesToPrompt(request.messages), "utf8");
  if (promptBytes > appConfig.maxPromptBytes) {
    return { error: openaiError(`messages exceed max prompt size (${appConfig.maxPromptBytes} bytes)`, "context_length_exceeded", 413) };
  }

  if (request.model !== undefined && typeof request.model !== "string") return { error: openaiError("model must be a string") };
  if (request.session_id !== undefined && typeof request.session_id !== "string") return { error: openaiError("session_id must be a string") };
  if (typeof request.session_id === "string" && request.session_id.length > 256) return { error: openaiError("session_id must be at most 256 characters") };
  if (request.user !== undefined && typeof request.user !== "string") return { error: openaiError("user must be a string") };

  if (request.stream !== undefined && typeof request.stream !== "boolean") return { error: openaiError("stream must be a boolean") };
  if (request.enable_tools !== undefined && typeof request.enable_tools !== "boolean") return { error: openaiError("enable_tools must be a boolean") };

  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) return { error: openaiError("temperature must be a finite number") };
  if (request.top_p !== undefined && !Number.isFinite(request.top_p)) return { error: openaiError("top_p must be a finite number") };
  if (request.max_tokens !== undefined && (!Number.isFinite(request.max_tokens) || !Number.isInteger(request.max_tokens) || request.max_tokens <= 0)) {
    return { error: openaiError("max_tokens must be a positive integer") };
  }

  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) return { error: openaiError("tools must be an array") };
    if (request.tools.length > 128) return { error: openaiError("tools must contain at most 128 items") };
  }

  if (request.claude !== undefined && !isRecord(request.claude)) return { error: openaiError("claude must be an object") };

  return request;
};

const parseToolChoice = (toolChoice: unknown): OpenAIToolChoice | { readonly error: ReturnType<typeof openaiError> } => {
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  if (!toolChoice || typeof toolChoice !== "object") return { error: openaiError("tool_choice must be 'auto', 'none', or a function tool choice") };
  const record = toolChoice as { type?: unknown; function?: unknown };
  if (record.type !== "function" || !record.function || typeof record.function !== "object") return { error: openaiError("tool_choice object must be { type: 'function', function: { name } }") };
  const fn = record.function as { name?: unknown };
  return typeof fn.name === "string" && fn.name ? { type: "function", function: { name: fn.name } } : { error: openaiError("tool_choice.function.name must be a non-empty string") };
};

const getOpenAIFunctionToolName = (tool: unknown): string | undefined => {
  if (!tool || typeof tool !== "object") return undefined;
  const record = tool as { type?: unknown; function?: unknown };
  if (record.type !== "function" || !record.function || typeof record.function !== "object") return undefined;
  const fn = record.function as { name?: unknown };
  return typeof fn.name === "string" && fn.name ? fn.name : undefined;
};

const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const escapeXmlAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const messagesToPrompt = (messages: readonly ChatMessage[]): string =>
  messages
    .map((message) => {
      const role =
        message.role === "system" || message.role === "developer" || message.role === "assistant" || message.role === "tool" || message.role === "user"
          ? message.role
          : "user";
      const text = contentToText(message.content).trim();
      if (!text) return "";
      const roleAttr = escapeXmlAttribute(role);
      const nameAttr = role === "tool" && typeof message.name === "string" && message.name ? ` name="${escapeXmlAttribute(message.name)}"` : "";
      return `<message role="${roleAttr}"${nameAttr}>\n${text}\n</message>`;
    })
    .filter(Boolean)
    .join("\n\n");

export const modelAliases = (): readonly string[] => appConfig.models;

export const modelToClaudeAlias = (model: string | undefined): string | undefined => {
  if (!model || model === "claude") return appConfig.defaultModel;
  const normalized = model.toLowerCase();
  if (normalized === "gpt-4o" || normalized === "gpt-4" || normalized === "gpt-4.1") return appConfig.defaultModel;
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("sonnet") || normalized === "claude") return "sonnet";
  return model;
};

const resolveToolStrategy = (request: ChatCompletionRequest): ResolvedToolStrategy | { readonly error: ReturnType<typeof openaiError> } => {
  const explicitTools = request.claude?.tools;
  const explicitAllowed = request.claude?.allowedTools;
  const explicitDisallowed = request.claude?.disallowedTools;
  if (explicitTools || explicitAllowed || explicitDisallowed) {
    return {
      kind: "claudeExplicit",
      ...(explicitTools ? { tools: explicitTools } : {}),
      ...(explicitAllowed ? { allowedTools: explicitAllowed } : {}),
      ...(explicitDisallowed ? { disallowedTools: explicitDisallowed } : {}),
      ...(request.claude?.enableTools !== undefined ? { enableTools: request.claude.enableTools } : {}),
      ...(request.claude?.toolMode ? { toolMode: request.claude.toolMode } : {}),
    };
  }

  if (request.tools?.length) {
    const choice = parseToolChoice(request.tool_choice);
    if (typeof choice === "object" && "error" in choice) return choice;
    if (choice === "none") return { kind: "disabled" };
    if (choice !== "auto") {
      const selectedName = choice.function.name;
      const selectedTool = request.tools.find((tool) => getOpenAIFunctionToolName(tool) === selectedName);
      if (!selectedTool) {
        return { error: openaiError(`tool_choice.function.name does not match any provided tool: ${selectedName}`) };
      }
      return { kind: "openaiAdapter", tools: [selectedTool], choice };
    }
    return { kind: "openaiAdapter", tools: request.tools, choice };
  }

  if (request.tool_choice !== undefined && request.tool_choice !== null && request.tool_choice !== "none" && request.tool_choice !== "auto") {
    return { error: openaiError("tool_choice requires a non-empty tools array") };
  }

  const enableTools = request.enable_tools || request.claude?.enableTools;
  if (!enableTools) return { kind: "disabled" };

  const mode = request.claude?.toolMode ?? "readonly";
  if (mode === "all" || mode === "safe" || mode === "readonly") return { kind: "claudeMode", mode };
  return { error: openaiError(`Unsupported claude.toolMode: ${mode}`) };
};

const toolStrategyToClaudeArgs = (strategy: ResolvedToolStrategy): Pick<ClaudeArgs, "allowedTools" | "disallowedTools" | "tools" | "openAITools" | "enableTools" | "toolMode"> => {
  switch (strategy.kind) {
    case "disabled":
      return { enableTools: false, tools: [], disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"] };
    case "claudeExplicit":
      return {
        ...(strategy.tools ? { tools: strategy.tools } : {}),
        ...(strategy.allowedTools ? { allowedTools: strategy.allowedTools } : {}),
        ...(strategy.disallowedTools ? { disallowedTools: strategy.disallowedTools } : {}),
        ...(strategy.enableTools !== undefined ? { enableTools: strategy.enableTools } : {}),
        ...(strategy.toolMode ? { toolMode: strategy.toolMode } : {}),
      };
    case "openaiAdapter":
      return { enableTools: true, openAITools: [...strategy.tools], tools: [], allowedTools: [], disallowedTools: [] };
    case "claudeMode":
      if (strategy.mode === "all") return { enableTools: true, toolMode: strategy.mode, tools: [], allowedTools: [], disallowedTools: [] };
      if (strategy.mode === "safe") return { enableTools: true, toolMode: strategy.mode, tools: [...DEFAULT_SAFE_TOOLS], allowedTools: [...DEFAULT_SAFE_TOOLS], disallowedTools: [...DANGEROUS_TOOLS] };
      return { enableTools: true, toolMode: "readonly", tools: [...DEFAULT_READONLY_TOOLS], allowedTools: [...DEFAULT_READONLY_TOOLS], disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"] };
  }
};

export const toClaudeArgs = (request: ChatCompletionRequest): ClaudeArgs | { readonly error: ReturnType<typeof openaiError> } => {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: openaiError("messages must be a non-empty array") };
  }
  const prompt = messagesToPrompt(request.messages);
  if (!prompt.trim()) return { error: openaiError("messages did not contain any text content") };
  const toolStrategy = resolveToolStrategy(request);
  if ("error" in toolStrategy) return { error: toolStrategy.error };
  const model = modelToClaudeAlias(request.model);

  if (request.temperature !== undefined || request.top_p !== undefined || request.max_tokens !== undefined || request.user !== undefined) {
    traceEvent(
      "adapter.ignored_openai_params",
      {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
        ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
        ...(request.user !== undefined ? { user: request.user } : {}),
      },
      "debug",
    );
  }

  return {
    prompt,
    ...(request.session_id ? { sessionId: request.session_id } : {}),
    ...(request.claude?.sessionId ? { sessionId: request.claude.sessionId } : {}),
    ...(request.claude?.isolated !== undefined ? { isolated: request.claude.isolated } : {}),
    ...(request.claude?.resetSession !== undefined ? { resetSession: request.claude.resetSession } : {}),
    ...(model ? { model } : {}),
    ...(request.claude?.model ? { model: request.claude.model } : {}),
    ...(request.claude?.effort ? { effort: request.claude.effort } : {}),
    ...(request.claude?.workingDirectory ? { workingDirectory: request.claude.workingDirectory } : {}),
    ...(request.claude?.permissionMode ? { permissionMode: request.claude.permissionMode } : { permissionMode: request.enable_tools ? "acceptEdits" : "default" }),
    ...toolStrategyToClaudeArgs(toolStrategy),
    ...(request.claude?.addDirs ? { addDirs: request.claude.addDirs } : {}),
    ...(request.claude?.bare !== undefined ? { bare: request.claude.bare } : {}),
  };
};

export const createChatCompletionId = (): string => `chatcmpl-${randomUUID().replaceAll("-", "")}`;

export const modelListResponse = () => ({
  object: "list",
  data: modelAliases().map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "claude-code",
  })),
});

export const chatCompletionResponse = (id: string, model: string, content: string) => ({
  id,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
});

export const chatCompletionToolCallResponse = (id: string, model: string, toolCalls: readonly OpenAIResponseToolCall[], content: string | null = null) => ({
  id,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    },
  ],
});

export const streamChunk = (id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null) => ({
  id,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

export const __test__ = { parseToolChoice, resolveToolStrategy, toolStrategyToClaudeArgs };
