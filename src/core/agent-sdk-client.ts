import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { debugEnabled, filteredClaudeEnv, isTruthy } from "../env-policy.js";
import { validateWorkingDirectory } from "../working-directory.js";
import type { ClaudeArgs } from "../schemas.js";
import { traceEvent } from "../trace.js";
import type { ClaudeRunOptions, ClaudeRunResult, ClaudeStreamCallbacks, ClaudeStreamEvent, OpenAIToolCallResult } from "../types.js";
import type { ClaudeClient } from "./claude-client.js";
import { createCapturedToolCallFromRequirements, createOpenAIToolAdapter, extractToolCallsFromSdkMessage, mergeToolCall, toolSchemaRequirementsFromArgs } from "./openai-tool-adapter.js";

const sdkEnv = filteredClaudeEnv;

const claudeConfigDirOverride = (): string | undefined => process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
const sdkClientApp = (): string => process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP || "claude-code";

const normalizePermissionMode = (input: ClaudeArgs["permissionMode"]): PermissionMode => {
  if (!input || input === "default") return "default";
  if (input === "auto") return "acceptEdits";
  if (input === "acceptEdits" || input === "plan") return input;
  return "default";
};

const assertSdkSafety = async (args: ClaudeArgs): Promise<ClaudeArgs> => {
  const allowBypass = isTruthy(process.env.CLAUDE_OPENAI_ALLOW_BYPASS_PERMISSIONS);
  const allowExplicitTools = isTruthy(process.env.CLAUDE_OPENAI_ALLOW_EXPLICIT_TOOLS);

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

const stringifyDebug = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const errorMessageFromResult = (message: SDKMessage): string | undefined => {
  if (message.type !== "result" || message.subtype === "success") return undefined;
  const record = message as unknown as Record<string, unknown>;
  for (const key of ["error", "message", "result", "stderr"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const toolsAreEnabled = (args: ClaudeArgs): boolean => args.enableTools || Boolean(args.tools?.length || args.allowedTools?.length || args.openAITools?.length);

const sdkToolsFor = (args: ClaudeArgs, openAIToolAdapter: ReturnType<typeof createOpenAIToolAdapter>, toolsEnabled: boolean) =>
  openAIToolAdapter?.tools ? [...openAIToolAdapter.tools] : args.tools?.length ? [...args.tools] : toolsEnabled ? { type: "preset" as const, preset: "claude_code" as const } : [];

const toolPermissionOptions = (
  args: ClaudeArgs,
  openAIToolAdapter: ReturnType<typeof createOpenAIToolAdapter>,
  requirements: ReturnType<typeof toolSchemaRequirementsFromArgs>,
  capturedToolCalls: OpenAIToolCallResult[],
  toolsEnabled: boolean,
): Pick<Options, "canUseTool" | "allowedTools"> => {
  if (!toolsEnabled) {
    return {
      allowedTools: [],
      canUseTool: async (toolName, _input, { toolUseID }) => ({
        behavior: "deny" as const,
        message: `Tool use is disabled by claude-openai: ${toolName}`,
        toolUseID,
      }),
    };
  }

  if (openAIToolAdapter) {
    return {
      canUseTool: async (toolName, input, { toolUseID }) => {
        if (!openAIToolAdapter.tools.includes(toolName)) {
          traceEvent("sdk.ignore_non_adapter_tool", { toolName, toolUseID, input }, "debug");
          return { behavior: "deny" as const, message: `Tool is not part of the OpenAI adapter: ${toolName}`, toolUseID };
        }
        const toolCall = createCapturedToolCallFromRequirements(toolName, toolUseID, input, requirements);
        traceEvent("sdk.can_use_tool", { toolName, openAIName: toolCall.function.name, toolUseID, input, arguments: toolCall.function.arguments }, "debug");
        const captured = mergeToolCall(capturedToolCalls, toolCall, requirements);
        return captured
          ? { behavior: "deny" as const, message: "Tool call captured by OpenAI-compatible server.", interrupt: true, toolUseID }
          : { behavior: "deny" as const, message: "Tool call is incomplete for its OpenAI schema; retry with required arguments.", toolUseID };
      },
    };
  }

  return args.allowedTools?.length ? { allowedTools: [...args.allowedTools] } : {};
};

const sdkEnvWithOverrides = (): NodeJS.ProcessEnv => ({
  ...filteredClaudeEnv(),
  ...(claudeConfigDirOverride() ? { CLAUDE_CONFIG_DIR: claudeConfigDirOverride() } : {}),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_AGENT_SDK_CLIENT_APP: sdkClientApp(),
});

const buildOptions = (args: ClaudeArgs, abortController: AbortController, capturedToolCalls: OpenAIToolCallResult[] = []): Options => {
  const permissionMode = normalizePermissionMode(args.permissionMode);
  const openAIToolAdapter = createOpenAIToolAdapter(args);
  const requirements = toolSchemaRequirementsFromArgs(args);
  const hasOpenAIToolAdapter = Boolean(openAIToolAdapter);
  const toolsEnabled = toolsAreEnabled(args);
  const sdkTools = sdkToolsFor(args, openAIToolAdapter, toolsEnabled);
  const denyTools = !toolsEnabled;
  return {
    abortController,
    cwd: args.workingDirectory || process.cwd(),
    ...(args.model ? { model: args.model } : {}),
    maxTurns: hasOpenAIToolAdapter ? 1 : toolsEnabled ? 10 : 1,
    systemPrompt: hasOpenAIToolAdapter ? "" : toolsEnabled ? { type: "preset", preset: "claude_code" } : "",
    settingSources: [],
    mcpServers: openAIToolAdapter?.mcpServers || {},
    strictMcpConfig: true,
    includePartialMessages: true,
    tools: sdkTools,
    ...toolPermissionOptions(args, openAIToolAdapter, requirements, capturedToolCalls, toolsEnabled),
    ...(args.disallowedTools?.length ? { disallowedTools: [...args.disallowedTools] } : {}),
    permissionMode: denyTools ? "dontAsk" : permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(args.addDirs?.length ? { additionalDirectories: [...args.addDirs] } : {}),
    ...(args.sessionId && !args.resetSession ? { resume: args.sessionId } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    env: sdkEnvWithOverrides(),
  };
};

export class AgentSdkClaudeClient implements ClaudeClient {
  async execute(args: ClaudeArgs, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return this.executeStreaming(args, {}, options);
  }

  async executeStreaming(args: ClaudeArgs, callbacks: ClaudeStreamCallbacks = {}, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    const safeArgs = await assertSdkSafety(args);
    traceEvent("sdk.execute_streaming.start", { args: safeArgs }, "debug");
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    let index = 0;
    let text = "";
    let lastAssistantSnapshot = "";
    let emittedStreamText = "";
    let finalSessionId: string | undefined;
    let usage: unknown;
    const toolCalls: OpenAIToolCallResult[] = [];
    const requirements = toolSchemaRequirementsFromArgs(safeArgs);
    const hasOpenAIToolAdapter = Boolean(safeArgs.openAITools?.length);
    const collectRawMessages = debugEnabled();
    const rawMessages: unknown[] = [];

    try {
      for await (const message of query({ prompt: safeArgs.prompt, options: buildOptions(safeArgs, abortController, toolCalls) })) {
        if (collectRawMessages) rawMessages.push(message);
        traceEvent("sdk.message", message, "trace");
        const event = toStreamEvent(message);
        await callbacks.onEvent?.(event, index);
        if (hasOpenAIToolAdapter) {
          const structuredToolCalls = extractToolCallsFromSdkMessage(message, requirements);
          for (const call of structuredToolCalls) {
            traceEvent("sdk.structured_tool_call", call, "debug");
            mergeToolCall(toolCalls, call, requirements);
          }
        }

        if ("session_id" in message && typeof message.session_id === "string") finalSessionId = message.session_id;

        if (message.type === "result") {
          if (message.subtype === "success") {
            text = message.result || text;
            usage = message.usage;
          } else {
            const resultSubtype = message.subtype as string | undefined;
            if (hasOpenAIToolAdapter && toolCalls.length && (resultSubtype === "error_max_turns" || resultSubtype === "interrupt" || resultSubtype === "error_during_execution")) {
              usage = "usage" in message ? message.usage : usage;
              index += 1;
              break;
            }
            if (debugEnabled()) console.error(`[claude-openai] SDK result error: ${stringifyDebug(message)}`);
            const errorMessage = errorMessageFromResult(message) ?? `Claude Agent SDK returned ${message.subtype || "an error"}`;
            throw new Error(errorMessage);
          }
          index += 1;
          continue;
        }

        const rawText = textFromSdkMessage(message);
        if (rawText) {
          const delta = (() => {
            if (message.type === "stream_event") return rawText;
            if (message.type !== "assistant") return rawText;
            const previousAssistantSnapshot = lastAssistantSnapshot;
            lastAssistantSnapshot = rawText;
            if (emittedStreamText && rawText.startsWith(emittedStreamText)) return rawText.slice(emittedStreamText.length);
            if (rawText.startsWith(text)) return rawText.slice(text.length);
            return previousAssistantSnapshot && rawText.startsWith(previousAssistantSnapshot) ? rawText.slice(previousAssistantSnapshot.length) : rawText;
          })();
          if (delta) {
            text += delta;
            if (message.type === "stream_event") emittedStreamText += delta;
            await callbacks.onText?.(delta, event, index);
          }
        }
        index += 1;
      }
    } catch (error) {
      if (debugEnabled()) {
        console.error(`[claude-openai] SDK execution failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (rawMessages.length) console.error(`[claude-openai] SDK raw messages before failure: ${stringifyDebug(rawMessages)}`);
      }
      traceEvent("sdk.error", { error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error), rawMessages, toolCalls }, "debug");
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }

    const result = {
      text,
      stdout: collectRawMessages ? JSON.stringify(rawMessages) : "",
      stderr: "",
      exitCode: 0,
      ...(finalSessionId ? { claudeSessionId: finalSessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    traceEvent("sdk.execute_streaming.result", result, "debug");
    return result;
  }
}

export const __test__ = {
  normalizePermissionMode,
  sdkEnv,
  assertSdkSafety,
  buildOptions,
  claudeConfigDirOverride,
  sdkClientApp,
};
