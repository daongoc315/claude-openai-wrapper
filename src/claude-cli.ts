import { Effect, Schema } from "effect";
import { appConfig } from "./config.js";
import { ClaudeCliError, ValidationError } from "./errors.js";
import { runSupervisedProcess, runSupervisedStreamingProcess } from "./process-supervisor.js";
import { ClaudeArgsSchema, type ClaudeArgs } from "./schemas.js";
import { sessionStore } from "./session-store.js";
import type { ClaudeJsonOutput, ClaudeRunOptions, ClaudeRunResult, ClaudeStreamCallbacks, ClaudeStreamEvent } from "./types.js";

const appendListFlag = (args: string[], flag: string, values?: readonly string[]): void => {
  if (!values?.length) return;
  args.push(flag, values.join(","));
};

export const normalizeModelName = (model: string): string => {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  return model;
};

type ClaudeCliArgsInput = ClaudeArgs & { readonly stream?: boolean };

export const buildClaudeArgs = (input: ClaudeCliArgsInput, claudeSessionId?: string): string[] => {
  const shouldStream = input.stream !== false;
  const args = ["-p", input.prompt, "--output-format", shouldStream ? "stream-json" : "json"];

  if (shouldStream) args.push("--verbose", "--include-partial-messages");

  if (claudeSessionId) args.push("--resume", claudeSessionId);
  if (input.model) args.push("--model", normalizeModelName(input.model));
  if (input.effort) args.push("--effort", input.effort);
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
  if (input.bare) args.push("--bare");

  appendListFlag(args, "--allowedTools", input.allowedTools);
  appendListFlag(args, "--disallowedTools", input.disallowedTools);
  appendListFlag(args, "--tools", input.tools);
  for (const dir of input.addDirs ?? []) args.push("--add-dir", dir);

  return args;
};

const validatePromptSize = (prompt: string): Effect.Effect<void, ClaudeCliError> =>
  Buffer.byteLength(prompt, "utf8") <= appConfig.maxPromptBytes
    ? Effect.void
    : Effect.fail(
        new ClaudeCliError({
          code: "CLAUDE_SPAWN_ERROR",
          message: `Prompt exceeds CLAUDE_OPENAI_MAX_PROMPT_BYTES (${appConfig.maxPromptBytes})`,
        }),
      );

const validatePermissionMode = (permissionMode: ClaudeArgs["permissionMode"]): Effect.Effect<void, ClaudeCliError> => {
  if (!permissionMode || appConfig.allowedPermissionModes.includes(permissionMode)) return Effect.void;
  return Effect.fail(
    new ClaudeCliError({
      code: "CLAUDE_SPAWN_ERROR",
      message: `permissionMode is not allowed: ${permissionMode}`,
    }),
  );
};

export const spawnCommand = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly sessionId?: string;
    readonly label?: string;
    readonly promptPreview?: string;
    readonly signal?: AbortSignal;
  } = {},
) => runSupervisedProcess(command, args, options);

export const parseClaudeStreamLine = (line: string): ClaudeStreamEvent | undefined => {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return undefined;
  }
};

const parseClaudeJsonOutput = (stdout: string): ClaudeJsonOutput | undefined => {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as ClaudeJsonOutput;
  } catch {
    return undefined;
  }
};

const textFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
};

const textDeltaFromEvent = (event: ClaudeStreamEvent): string => {
  const delta = (event as { delta?: unknown }).delta;
  if (delta && typeof delta === "object") {
    const text = (delta as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return textFromContent(event.message?.content);
};

export const decodeClaudeArgs = (input: unknown): Effect.Effect<ClaudeArgs, ValidationError> =>
  Schema.decodeUnknown(ClaudeArgsSchema)(input).pipe(
    Effect.mapError(
      (error) =>
        new ValidationError({
          message: error.message,
        }),
    ),
  );

export const runClaude = (input: ClaudeArgs, options: ClaudeRunOptions = {}): Effect.Effect<ClaudeRunResult, ClaudeCliError> =>
  Effect.gen(function* () {
    const requestedSessionId = input.sessionId?.trim() || undefined;
    const effectiveSession = requestedSessionId ? sessionStore.getOrCreate(requestedSessionId) : undefined;
    yield* validatePromptSize(input.prompt);
    yield* validatePermissionMode(input.permissionMode);
    const args = buildClaudeArgs({ ...input, stream: false }, input.resetSession ? undefined : effectiveSession?.claudeSessionId);
    if (input.resetSession && requestedSessionId) sessionStore.reset(requestedSessionId);
    const result = yield* spawnCommand(appConfig.claudeCommand, args, {
      ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
      ...(effectiveSession?.id ? { sessionId: effectiveSession.id } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      label: "claude",
      promptPreview: input.prompt.slice(0, 240),
    });
    const parsed = parseClaudeJsonOutput(result.stdout);
    const claudeSessionId = typeof parsed?.session_id === "string" ? parsed.session_id : undefined;
    const text = typeof parsed?.result === "string" ? parsed.result : result.stdout;
    if (effectiveSession?.id) sessionStore.recordTurn(effectiveSession.id, { prompt: input.prompt, response: text, ...(claudeSessionId ? { claudeSessionId } : {}) });
    return {
      text,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(parsed ? { parsed } : {}),
      ...(effectiveSession?.id ? { wrapperSessionId: effectiveSession.id } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
  });

export const runClaudeStreaming = (
  input: ClaudeArgs,
  callbacks: ClaudeStreamCallbacks = {},
  options: ClaudeRunOptions = {},
): Effect.Effect<ClaudeRunResult, ClaudeCliError> =>
  Effect.gen(function* () {
    const requestedSessionId = input.sessionId?.trim() || undefined;
    const effectiveSession = requestedSessionId ? sessionStore.getOrCreate(requestedSessionId) : undefined;
    yield* validatePromptSize(input.prompt);
    yield* validatePermissionMode(input.permissionMode);
    const args = buildClaudeArgs({ ...input, stream: true }, input.resetSession ? undefined : effectiveSession?.claudeSessionId);
    if (input.resetSession && requestedSessionId) sessionStore.reset(requestedSessionId);

    let finalParsed: ClaudeJsonOutput | undefined;
    let claudeSessionId: string | undefined;
    let lastAssistantText = "";
    let streamedText = "";
    let eventIndex = 0;

    const result = yield* runSupervisedStreamingProcess(appConfig.claudeCommand, args, {
      ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
      ...(effectiveSession?.id ? { sessionId: effectiveSession.id } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      label: "claude",
      promptPreview: input.prompt.slice(0, 240),
      onStdoutLine: async (line) => {
        const event = parseClaudeStreamLine(line);
        if (!event) return;
        const currentEventIndex = eventIndex++;
        callbacks.onEvent?.(event, currentEventIndex);
        if (event.type === "result") {
          finalParsed = event as ClaudeJsonOutput;
          claudeSessionId = typeof event.session_id === "string" ? event.session_id : undefined;
          return;
        }

        const rawText = textDeltaFromEvent(event);
        if (!rawText) return;

        const delta = rawText.startsWith(lastAssistantText) ? rawText.slice(lastAssistantText.length) : rawText;
        lastAssistantText = rawText;
        if (!delta) return;
        streamedText += delta;
        callbacks.onText?.(delta, event, currentEventIndex);
      },
    });

    const text = typeof finalParsed?.result === "string" ? finalParsed.result : streamedText || result.stdout;
    if (effectiveSession?.id) sessionStore.recordTurn(effectiveSession.id, { prompt: input.prompt, response: text, ...(claudeSessionId ? { claudeSessionId } : {}) });
    return {
      text,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(finalParsed ? { parsed: finalParsed } : {}),
      ...(effectiveSession?.id ? { wrapperSessionId: effectiveSession.id } : {}),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
  });
