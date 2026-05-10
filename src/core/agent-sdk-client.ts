import { query, type Options, type PermissionMode, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { debugEnabled, filteredClaudeEnv, isTruthy } from "../env-policy.js";
import { validateWorkingDirectory } from "../working-directory.js";
import type { ClaudeArgs } from "../schemas.js";
import { sessionStore } from "../session-store.js";
import { traceEvent } from "../trace.js";
import type { ClaudeRunOptions, ClaudeRunResult, ClaudeStreamCallbacks, ClaudeStreamEvent, OpenAIToolCallResult } from "../types.js";
import type { ClaudeClient } from "./claude-client.js";
import { createCapturedToolCallFromRequirements, createOpenAIToolAdapter, extractToolCallsFromSdkMessage, mergeToolCall, toolSchemaRequirementsFromArgs } from "./openai-tool-adapter.js";

const sdkEnv = filteredClaudeEnv;

const claudeConfigDirOverride = (): string | undefined => process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
const DEFAULT_AGENT_SDK_CLIENT_APP = "claude-code"; // Required by the Claude Agent SDK to identify this wrapper
const sdkClientApp = (): string => process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP || DEFAULT_AGENT_SDK_CLIENT_APP;

const normalizePermissionMode = (input: ClaudeArgs["permissionMode"]): PermissionMode => {
  if (!input || input === "default") return "default";
  // "auto" is an OpenAI-compat alias; the SDK expects "acceptEdits" for auto-approve behavior
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
    // Heuristic: check common SDK error output fields in priority order
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const claudeArgsSummary = (args: ClaudeArgs): Record<string, unknown> => ({
  model: args.model,
  sessionId: args.sessionId,
  resetSession: args.resetSession,
  promptChars: args.prompt.length,
  enableTools: args.enableTools,
  toolMode: args.toolMode,
  permissionMode: args.permissionMode,
  workingDirectory: args.workingDirectory,
  toolsCount: args.tools?.length ?? 0,
  allowedToolsCount: args.allowedTools?.length ?? 0,
  disallowedToolsCount: args.disallowedTools?.length ?? 0,
  openAIToolsCount: args.openAITools?.length ?? 0,
});

const toolsAreEnabled = (args: ClaudeArgs): boolean => args.enableTools || Boolean(args.tools?.length || args.allowedTools?.length || args.openAITools?.length);

const sdkToolsFor = (args: ClaudeArgs, openAIToolAdapter: ReturnType<typeof createOpenAIToolAdapter>, toolsEnabled: boolean) => {
  // OpenAI tool adapter takes priority — its tools are proxied through canUseTool
  if (openAIToolAdapter?.tools) return [...openAIToolAdapter.tools];
  // Explicit tools list from args
  if (args.tools?.length) return [...args.tools];
  // Enable the full claude_code preset when tools are enabled
  if (toolsEnabled) return { type: "preset" as const, preset: "claude_code" as const };
  return [];
};

// maxTurns controls how many SDK agentic loop iterations are allowed.
// - OpenAI tool adapter: 1 turn — the OpenAI client handles the outer tool loop
// - Claude tools enabled: 5 turns — allow the SDK to do multi-step tool use
// - No tools: 1 turn — single response, no looping needed
const MAX_TURNS_OPENAI_ADAPTER = 1;
const MAX_TURNS_CLAUDE_TOOLS = 5;
const MAX_TURNS_NO_TOOLS = 1;

const maxTurnsFor = (toolsEnabled: boolean, hasOpenAIToolAdapter: boolean): number => {
  if (hasOpenAIToolAdapter) return MAX_TURNS_OPENAI_ADAPTER;
  return toolsEnabled ? MAX_TURNS_CLAUDE_TOOLS : MAX_TURNS_NO_TOOLS;
};

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
        // Intentional: we use behavior:"deny" + interrupt:true as a signal to stop the SDK loop
        // and surface the captured tool call to the OpenAI-compatible caller.
        // The SDK treats this deny+interrupt as a clean loop exit, not an error.
        return captured
          ? { behavior: "deny" as const, message: "Tool call captured.", interrupt: true, toolUseID }
          : { behavior: "deny" as const, message: "Tool call is incomplete for its OpenAI schema; retry with required arguments.", toolUseID };
      },
    };
  }

  return args.allowedTools?.length ? { allowedTools: [...args.allowedTools] } : {};
};

const sdkEnvWithOverrides = (): NodeJS.ProcessEnv => ({
  ...filteredClaudeEnv(),
  ...(claudeConfigDirOverride() ? { CLAUDE_CONFIG_DIR: claudeConfigDirOverride() } : {}),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", // Disable Claude's auto-memory feature — this wrapper manages session state explicitly
  CLAUDE_AGENT_SDK_CLIENT_APP: sdkClientApp(),
});

// Standard UUID v1–v5 pattern (version nibble [1-5], variant bits [89ab]).
// Used to detect when a caller passes a raw Claude session ID instead of a wrapper session ID.
const CLAUDE_SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Heuristic: if the caller's session ID looks like a UUID, treat it as a direct Claude
// resume ID (bypassing the wrapper session map). This allows clients to pass through
// Claude session IDs they received from a previous response.
const looksLikeClaudeResumeId = (value: string): boolean => CLAUDE_SESSION_ID_REGEX.test(value);

const sessionExecutionLocks = new Map<string, Promise<void>>();

const withSessionExecutionLock = async <T>(sessionId: string | undefined, run: () => Promise<T>): Promise<T> => {
  if (!sessionId) return run();

  const previous = sessionExecutionLocks.get(sessionId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  sessionExecutionLocks.set(sessionId, chained);

  traceEvent("sdk.session_lock.wait", { sessionId }, "trace");
  await previous.catch(() => undefined);
  traceEvent("sdk.session_lock.acquired", { sessionId }, "trace");
  try {
    return await run();
  } finally {
    releaseCurrent();
    if (sessionExecutionLocks.get(sessionId) === chained) sessionExecutionLocks.delete(sessionId);
    traceEvent("sdk.session_lock.released", { sessionId }, "trace");
  }
};

const buildOptions = (args: ClaudeArgs, abortController: AbortController, capturedToolCalls: OpenAIToolCallResult[] = [], claudeSessionId?: string): Options => {
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
    maxTurns: maxTurnsFor(toolsEnabled, hasOpenAIToolAdapter),
    systemPrompt: hasOpenAIToolAdapter ? "" : toolsEnabled ? { type: "preset", preset: "claude_code" } : "",
    // Note: empty string "" is used (not undefined) to explicitly suppress the default system prompt
    settingSources: [], // Disable all user/project Claude settings — wrapper controls all config
    mcpServers: openAIToolAdapter?.mcpServers || {},
    strictMcpConfig: true, // Reject unknown MCP server fields to avoid silent misconfiguration
    includePartialMessages: true, // Required for streaming text deltas via assistant_delta events
    tools: sdkTools,
    ...toolPermissionOptions(args, openAIToolAdapter, requirements, capturedToolCalls, toolsEnabled),
    ...(args.disallowedTools?.length ? { disallowedTools: [...args.disallowedTools] } : {}),
    permissionMode: denyTools ? "dontAsk" : permissionMode,
    // When tools are disabled, use "dontAsk" to prevent the SDK from prompting for permissions
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(args.addDirs?.length ? { additionalDirectories: [...args.addDirs] } : {}),
    ...(claudeSessionId && !args.resetSession ? { resume: claudeSessionId } : {}),
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
    const lockSessionId = safeArgs.sessionId?.trim() || undefined;
    return withSessionExecutionLock(lockSessionId, () => this.executeStreamingLocked(safeArgs, callbacks, options));
  }

  private async executeStreamingLocked(safeArgs: ClaudeArgs, callbacks: ClaudeStreamCallbacks = {}, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    traceEvent("sdk.execute_streaming.start", { args: claudeArgsSummary(safeArgs) }, "debug");
    traceEvent("sdk.execute_streaming.start_full", { args: safeArgs }, "trace");

    const requestedSessionId = safeArgs.sessionId?.trim() || undefined;
    const effectiveSession = requestedSessionId ? sessionStore.getOrCreate(requestedSessionId) : undefined;
    if (safeArgs.resetSession && requestedSessionId) sessionStore.reset(requestedSessionId);
    const directResumeSessionId = requestedSessionId && looksLikeClaudeResumeId(requestedSessionId) ? requestedSessionId : undefined;
    const resumeSessionId = safeArgs.resetSession ? undefined : effectiveSession?.claudeSessionId || directResumeSessionId;
    traceEvent(
      "sdk.session_mapping",
      {
        requestedSessionId,
        wrapperSessionId: effectiveSession?.id,
        storedClaudeSessionId: effectiveSession?.claudeSessionId,
        resumeSessionId,
        resetSession: Boolean(safeArgs.resetSession),
      },
      "debug",
    );

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
      for await (const message of query({ prompt: safeArgs.prompt, options: buildOptions(safeArgs, abortController, toolCalls, resumeSessionId) })) {
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
            // For OpenAI tool adapter: treat these SDK result types as successful loop exits.
            // "interrupt" = tool call was captured (normal exit).
            // "error_max_turns" = max turns reached (surface what we have).
            // "error_during_execution" = tool execution error (let the caller handle it).
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
          // Delta calculation for streaming: the SDK may emit full assistant snapshots or incremental
          // text deltas. We track emittedStreamText (what we've already sent) and compute the new
          // suffix to avoid re-emitting content. previousAssistantSnapshot handles the case where
          // the SDK sends a full snapshot instead of a delta.
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

    if (effectiveSession?.id)
      sessionStore.recordTurn(effectiveSession.id, { prompt: safeArgs.prompt, response: text, ...(finalSessionId ? { claudeSessionId: finalSessionId } : {}) });
    if (effectiveSession?.id && finalSessionId) traceEvent("sdk.session_mapping.recorded", { wrapperSessionId: effectiveSession.id, claudeSessionId: finalSessionId }, "debug");

    const result = {
      text,
      stdout: collectRawMessages ? JSON.stringify(rawMessages) : "",
      stderr: "",
      exitCode: 0,
      ...(effectiveSession?.id ? { wrapperSessionId: effectiveSession.id } : {}),
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
  withSessionExecutionLock,
};
