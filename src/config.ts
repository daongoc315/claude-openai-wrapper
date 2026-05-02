import { Schema } from "effect";

const splitCsvEnv = (name: string, fallback: readonly string[]): readonly string[] => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const firstEnv = (names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
};

const numberFromEnv = (name: string | readonly string[], fallback: number): number => {
  const raw = typeof name === "string" ? process.env[name] : firstEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const stringFromEnv = (name: string | readonly string[], fallback: string): string =>
  (typeof name === "string" ? process.env[name] : firstEnv(name)) || fallback;

export const ConfigSchema = Schema.Struct({
  claudeCommand: Schema.NonEmptyString,
  backend: Schema.Literal("sdk", "cli"),
  httpHost: Schema.String,
  httpPort: Schema.Number,
  apiKey: Schema.optional(Schema.String),
  allowedPermissionModes: Schema.Array(Schema.String),
  allowedWorkingDirectoryPrefixes: Schema.Array(Schema.String),
  defaultModel: Schema.String,
  models: Schema.Array(Schema.String),
  maxRequestBytes: Schema.Number,
  corsOrigins: Schema.Array(Schema.String),
  maxConcurrentClaudeProcesses: Schema.Number,
  queueIntervalCap: Schema.Number,
  queueIntervalMs: Schema.Number,
  queueTaskTimeoutMs: Schema.Number,
  maxQueueSize: Schema.Number,
  processTimeoutMs: Schema.Number,
  killGracePeriodMs: Schema.Number,
  maxPromptBytes: Schema.Number,
  maxOutputBytes: Schema.Number,
  maxReturnedErrorBytes: Schema.Number,
  sessionIdleTtlMs: Schema.Number,
  lockWaitTimeoutMs: Schema.Number,
  shutdownGraceMs: Schema.Number,
});

export type AppConfig = Schema.Schema.Type<typeof ConfigSchema>;

export const appConfig: AppConfig = {
  claudeCommand: stringFromEnv(["CLAUDE_WRAPPER_CLAUDE_COMMAND", "CLAUDE_COMMAND"], "claude"),
  backend: stringFromEnv("CLAUDE_WRAPPER_BACKEND", "sdk") === "cli" ? "cli" : "sdk",
  httpHost: stringFromEnv("CLAUDE_WRAPPER_HOST", "127.0.0.1"),
  httpPort: numberFromEnv(["CLAUDE_WRAPPER_PORT", "PORT"], 8000),
  apiKey: firstEnv(["CLAUDE_WRAPPER_API_KEY", "API_KEY"]),
  allowedPermissionModes: splitCsvEnv("CLAUDE_WRAPPER_ALLOWED_PERMISSION_MODES", ["acceptEdits", "auto", "default", "plan"]),
  allowedWorkingDirectoryPrefixes: splitCsvEnv("CLAUDE_WRAPPER_ALLOWED_WORKING_DIR_PREFIXES", [process.cwd()]),
  defaultModel: stringFromEnv(["CLAUDE_DEFAULT_MODEL", "CLAUDE_WRAPPER_DEFAULT_MODEL"], "sonnet"),
  models: splitCsvEnv("CLAUDE_MODELS_OVERRIDE", ["claude", "claude-haiku", "claude-sonnet", "claude-opus", "sonnet", "opus", "haiku"]),
  maxRequestBytes: numberFromEnv("CLAUDE_WRAPPER_MAX_REQUEST_BYTES", 10 * 1024 * 1024),
  corsOrigins: splitCsvEnv("CORS_ORIGINS", ["*"]),
  maxConcurrentClaudeProcesses: numberFromEnv("CLAUDE_WRAPPER_MAX_CONCURRENCY", 2),
  queueIntervalCap: numberFromEnv("CLAUDE_WRAPPER_QUEUE_INTERVAL_CAP", 20),
  queueIntervalMs: numberFromEnv("CLAUDE_WRAPPER_QUEUE_INTERVAL_MS", 60_000),
  queueTaskTimeoutMs: numberFromEnv("CLAUDE_WRAPPER_QUEUE_TASK_TIMEOUT_MS", 180_000),
  maxQueueSize: numberFromEnv("CLAUDE_WRAPPER_MAX_QUEUE_SIZE", 100),
  processTimeoutMs: numberFromEnv("CLAUDE_WRAPPER_PROCESS_TIMEOUT_MS", 120_000),
  killGracePeriodMs: numberFromEnv("CLAUDE_WRAPPER_KILL_GRACE_PERIOD_MS", 5_000),
  maxPromptBytes: numberFromEnv("CLAUDE_WRAPPER_MAX_PROMPT_BYTES", 256 * 1024),
  maxOutputBytes: numberFromEnv("CLAUDE_WRAPPER_MAX_OUTPUT_BYTES", 10 * 1024 * 1024),
  maxReturnedErrorBytes: numberFromEnv("CLAUDE_WRAPPER_MAX_RETURNED_ERROR_BYTES", 8 * 1024),
  sessionIdleTtlMs: numberFromEnv("CLAUDE_WRAPPER_SESSION_TTL_MS", 30 * 60_000),
  lockWaitTimeoutMs: numberFromEnv("CLAUDE_WRAPPER_SESSION_LOCK_TIMEOUT_MS", 30_000),
  shutdownGraceMs: numberFromEnv("CLAUDE_WRAPPER_SHUTDOWN_GRACE_MS", 10_000),
};

export const truncate = (text: string | undefined, maxBytes = appConfig.maxReturnedErrorBytes): string | undefined => {
  if (!text) return undefined;
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n… truncated (${buffer.byteLength} bytes total)`;
};
