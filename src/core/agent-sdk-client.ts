import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { appConfig } from "../config.js";
import { validateWorkingDirectory } from "../process-supervisor.js";
import type { ClaudeArgs } from "../schemas.js";
import type { ClaudeRunOptions, ClaudeRunResult, ClaudeStreamCallbacks, ClaudeStreamEvent } from "../types.js";
import type { ClaudeClient } from "./claude-client.js";

const envAllowlist = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

const sdkEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (envAllowlist.has(key)) env[key] = value;
  }
  return env;
};

const normalizePermissionMode = (input: ClaudeArgs["permissionMode"]): PermissionMode => {
  if (!input || input === "default") return "default";
  if (input === "auto") return "acceptEdits";
  if (input === "acceptEdits" || input === "plan") return input;
  return "default";
};

const assertSdkSafety = async (args: ClaudeArgs): Promise<ClaudeArgs> => {
  const allowBypass = process.env.CLAUDE_WRAPPER_ALLOW_BYPASS_PERMISSIONS === "1";
  const allowExplicitTools = process.env.CLAUDE_WRAPPER_ALLOW_EXPLICIT_TOOLS === "1";

  if (!allowBypass && (args.permissionMode as string | undefined) === "bypassPermissions") {
    throw new Error("permissionMode bypassPermissions is not allowed");
  }
  if (!allowExplicitTools && args.tools?.length) {
    throw new Error("explicit tools are disabled by server policy");
  }

  const cwd = args.workingDirectory ? await validateWorkingDirectory(args.workingDirectory) : undefined;
  const validatedAddDirs = args.addDirs?.length ? await Promise.all(args.addDirs.map((dir) => validateWorkingDirectory(dir))) : undefined;
  return {
    ...args,
    ...(cwd ? { workingDirectory: cwd } : {}),
    ...(validatedAddDirs ? { addDirs: validatedAddDirs } : {}),
  };
};

const textFromContentBlocks = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
};

const textFromSdkMessage = (message: SDKMessage): string => {
  if (message.type === "assistant") return textFromContentBlocks(message.message.content);
  if (message.type === "stream_event") {
    const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
    return event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text ? event.delta.text : "";
  }
  return "";
};

const toStreamEvent = (message: SDKMessage): ClaudeStreamEvent => message as unknown as ClaudeStreamEvent;

const buildOptions = (args: ClaudeArgs, abortController: AbortController): Options => {
  const permissionMode = normalizePermissionMode(args.permissionMode);
  const toolsEnabled = args.enableTools || Boolean(args.tools?.length || args.allowedTools?.length);
  const sdkTools = args.tools?.length ? [...args.tools] : toolsEnabled ? { type: "preset" as const, preset: "claude_code" as const } : [];
  return {
    abortController,
    cwd: args.workingDirectory || process.cwd(),
    ...(args.model ? { model: args.model } : {}),
    maxTurns: toolsEnabled ? 10 : 1,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    includePartialMessages: true,
    tools: sdkTools,
    ...(args.allowedTools?.length ? { allowedTools: [...args.allowedTools] } : {}),
    ...(args.disallowedTools?.length ? { disallowedTools: [...args.disallowedTools] } : {}),
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(args.addDirs?.length ? { additionalDirectories: [...args.addDirs] } : {}),
    ...(args.sessionId && !args.resetSession ? { resume: args.sessionId } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    env: {
      ...sdkEnv(),
      CLAUDE_AGENT_SDK_CLIENT_APP: `${appConfig.backend}-openai-wrapper`,
    },
  };
};

export class AgentSdkClaudeClient implements ClaudeClient {
  async execute(args: ClaudeArgs, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return this.executeStreaming(args, {}, options);
  }

  async executeStreaming(args: ClaudeArgs, callbacks: ClaudeStreamCallbacks = {}, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    const safeArgs = await assertSdkSafety(args);
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    let index = 0;
    let text = "";
    let lastAssistantSnapshot = "";
    let finalSessionId: string | undefined;
    let usage: unknown;
    const rawMessages: unknown[] = [];

    try {
      for await (const message of query({ prompt: safeArgs.prompt, options: buildOptions(safeArgs, abortController) })) {
        rawMessages.push(message);
        const event = toStreamEvent(message);
        callbacks.onEvent?.(event, index);

        if ("session_id" in message && typeof message.session_id === "string") finalSessionId = message.session_id;

        if (message.type === "result") {
          if (message.subtype === "success") {
            text = message.result || text;
            usage = message.usage;
          } else {
            const errorMessage = "error" in message && typeof message.error === "string" ? message.error : "Claude Agent SDK returned an error";
            throw new Error(errorMessage);
          }
          index += 1;
          continue;
        }

        const rawText = textFromSdkMessage(message);
        if (rawText) {
          const delta = message.type === "assistant" && rawText.startsWith(lastAssistantSnapshot) ? rawText.slice(lastAssistantSnapshot.length) : rawText;
          if (message.type === "assistant") lastAssistantSnapshot = rawText;
          if (delta) {
            text += delta;
            callbacks.onText?.(delta, event, index);
          }
        }
        index += 1;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }

    return {
      text,
      stdout: JSON.stringify(rawMessages),
      stderr: "",
      exitCode: 0,
      ...(finalSessionId ? { claudeSessionId: finalSessionId } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}

export const __test__ = { normalizePermissionMode, sdkEnv, assertSdkSafety };
