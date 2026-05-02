import { Data } from "effect";

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
}> {}

export class ClaudeCliError extends Data.TaggedError("ClaudeCliError")<{
  readonly code:
    | "CLAUDE_NOT_FOUND"
    | "CLAUDE_TIMEOUT"
    | "CLAUDE_NON_ZERO_EXIT"
    | "CLAUDE_OUTPUT_TOO_LARGE"
    | "CLAUDE_CANCELED"
    | "CLAUDE_SPAWN_ERROR"
    | "QUEUE_FULL"
    | "QUEUE_TIMEOUT"
    | "SESSION_LOCK_TIMEOUT"
    | "SERVER_SHUTTING_DOWN"
    | "CLAUDE_QUEUE_ABORTED";
  readonly message: string;
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}> {}

export class JsonParseError extends Data.TaggedError("JsonParseError")<{
  readonly message: string;
  readonly stdout: string;
}> {}

export class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly toolName: string;
}> {}

export type AppError =
  | ValidationError
  | ClaudeCliError
  | JsonParseError
  | UnknownToolError;

export const formatError = (error: AppError): string => {
  switch (error._tag) {
    case "ValidationError":
      return `Validation error: ${error.message}`;
    case "ClaudeCliError":
      return [
        `Claude CLI error (${error.code}): ${error.message}`,
        error.exitCode === undefined ? undefined : `exitCode: ${error.exitCode}`,
        error.signal ? `signal: ${error.signal}` : undefined,
        error.durationMs === undefined ? undefined : `durationMs: ${error.durationMs}`,
        error.stderr ? `stderr: ${error.stderr}` : undefined,
        error.stdout ? `stdout: ${error.stdout}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    case "JsonParseError":
      return `Failed to parse Claude JSON output: ${error.message}\n\n${error.stdout}`;
    case "UnknownToolError":
      return `Unknown tool: ${error.toolName}`;
  }
};
