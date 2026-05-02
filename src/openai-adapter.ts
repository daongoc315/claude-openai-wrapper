import { randomUUID } from "node:crypto";
import { appConfig } from "./config.js";
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

export const messagesToPrompt = (messages: readonly ChatMessage[]): string =>
  messages
    .map((message) => {
      const role = message.role ?? "user";
      const text = contentToText(message.content).trim();
      if (!text) return "";
      if (role === "system" || role === "developer") return `System: ${text}`;
      if (role === "assistant") return `Assistant: ${text}`;
      if (role === "tool") return `Tool${message.name ? ` (${message.name})` : ""}: ${text}`;
      return `User: ${text}`;
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

const toolsFromRequest = (request: ChatCompletionRequest): Pick<ClaudeArgs, "allowedTools" | "disallowedTools" | "tools" | "enableTools" | "toolMode"> => {
  const explicitTools = request.claude?.tools;
  const explicitAllowed = request.claude?.allowedTools;
  const explicitDisallowed = request.claude?.disallowedTools;
  if (explicitTools || explicitAllowed || explicitDisallowed) {
    return {
      ...(explicitTools ? { tools: explicitTools } : {}),
      ...(explicitAllowed ? { allowedTools: explicitAllowed } : {}),
      ...(explicitDisallowed ? { disallowedTools: explicitDisallowed } : {}),
      ...(request.claude?.enableTools !== undefined ? { enableTools: request.claude.enableTools } : {}),
      ...(request.claude?.toolMode ? { toolMode: request.claude.toolMode } : {}),
    };
  }

  const enableTools = request.enable_tools || Boolean(request.tools?.length) || request.claude?.enableTools;
  if (!enableTools) return { enableTools: false, tools: [], disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"] };

  const mode = request.claude?.toolMode ?? "readonly";
  if (mode === "all") return { enableTools: true, toolMode: mode, tools: [], allowedTools: [], disallowedTools: [] };
  if (mode === "safe") return { enableTools: true, toolMode: mode, tools: [...DEFAULT_SAFE_TOOLS], allowedTools: [...DEFAULT_SAFE_TOOLS], disallowedTools: [...DANGEROUS_TOOLS] };
  return { enableTools: true, toolMode: "readonly", tools: [...DEFAULT_READONLY_TOOLS], allowedTools: [...DEFAULT_READONLY_TOOLS], disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"] };
};

export const toClaudeArgs = (request: ChatCompletionRequest): ClaudeArgs | { readonly error: ReturnType<typeof openaiError> } => {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: openaiError("messages must be a non-empty array") };
  }
  const prompt = messagesToPrompt(request.messages);
  if (!prompt.trim()) return { error: openaiError("messages did not contain any text content") };

  return {
    prompt,
    ...(request.session_id ? { sessionId: request.session_id } : {}),
    ...(request.claude?.sessionId ? { sessionId: request.claude.sessionId } : {}),
    ...(request.claude?.isolated !== undefined ? { isolated: request.claude.isolated } : {}),
    ...(request.claude?.resetSession !== undefined ? { resetSession: request.claude.resetSession } : {}),
    ...(modelToClaudeAlias(request.model) ? { model: modelToClaudeAlias(request.model) } : {}),
    ...(request.claude?.model ? { model: request.claude.model } : {}),
    ...(request.claude?.effort ? { effort: request.claude.effort } : {}),
    ...(request.claude?.workingDirectory ? { workingDirectory: request.claude.workingDirectory } : {}),
    ...(request.claude?.permissionMode ? { permissionMode: request.claude.permissionMode } : { permissionMode: request.enable_tools ? "acceptEdits" : "default" }),
    ...toolsFromRequest(request),
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

export const streamChunk = (id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null) => ({
  id,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});
