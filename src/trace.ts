import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SAFE_METRIC_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "inputtokens",
  "outputtokens",
  "cachecreationinputtokens",
  "cachereadinputtokens",
  "maxoutputtokens",
]);
const SECRET_KEY_PATTERNS = [/^authorization$/i, /^api[-_]?key$/i, /^access[-_]?token$/i, /^refresh[-_]?token$/i, /^id[-_]?token$/i, /secret/i, /password/i, /cookie/i];
const truthy = (value: string | undefined): boolean => value === "true" || value === "1" || value === "yes" || value === "on";
const falsy = (value: string | undefined): boolean => value === "false" || value === "0" || value === "no" || value === "off";
const LEVELS = { info: 0, debug: 1, trace: 2 } as const;
type LogLevel = keyof typeof LEVELS;

export const traceEnabled = (): boolean => !falsy(process.env.CLAUDE_OPENAI_LOG);

export const traceLevel = (): LogLevel => {
  const value = process.env.CLAUDE_OPENAI_LOG_LEVEL;
  if (value === "debug" || value === "trace" || value === "info") return value;
  return truthy(process.env.CLAUDE_OPENAI_TRACE) ? "trace" : "debug";
};

export const tracePath = (): string => resolve(process.env.CLAUDE_OPENAI_LOG_FILE || process.env.CLAUDE_OPENAI_TRACE_FILE || "claude-openai.log.ndjson");

const normalizedKey = (key: string): string => key.replace(/[-_]/g, "").toLowerCase();

const isSecretKey = (key: string): boolean => {
  if (SAFE_METRIC_KEYS.has(key) || SAFE_METRIC_KEYS.has(normalizedKey(key))) return false;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
};

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? "[REDACTED]" : redact(child);
  }
  return output;
};

const shouldLog = (level: LogLevel): boolean => traceEnabled() && LEVELS[level] <= LEVELS[traceLevel()];

export const traceEvent = (event: string, payload: unknown = {}, level: LogLevel = "debug"): void => {
  if (!shouldLog(level)) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, payload: redact(payload) })}\n`;
  const configuredPath = process.env.CLAUDE_OPENAI_LOG_FILE || process.env.CLAUDE_OPENAI_TRACE_FILE;
  if (!configuredPath) {
    process.stdout.write(line);
    return;
  }
  if (!traceEnabled()) return;
  const filePath = tracePath();
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, line);
};

export const __test__ = { falsy, isSecretKey, redact, shouldLog, traceLevel, truthy };
