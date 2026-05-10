import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test__, traceEvent } from "../trace.js";

afterEach(() => {
  delete process.env.CLAUDE_OPENAI_LOG;
  delete process.env.CLAUDE_OPENAI_LOG_FILE;
  delete process.env.CLAUDE_OPENAI_LOG_LEVEL;
  delete process.env.CLAUDE_OPENAI_TRACE;
  delete process.env.CLAUDE_OPENAI_TRACE_FILE;
});

test("trace redacts secret-like keys", () => {
  expect(__test__.redact({ authorization: "Bearer x", access_token: "tok", idToken: "jwt", nested: { apiKey: "secret", ok: true } })).toEqual({
    authorization: "[REDACTED]",
    access_token: "[REDACTED]",
    idToken: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", ok: true },
  });
});

test("trace keeps token usage metrics visible", () => {
  expect(
    __test__.redact({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
      modelUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 10,
        maxOutputTokens: 4096,
      },
    }),
  ).toEqual({
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    },
    modelUsage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 10,
      maxOutputTokens: 4096,
    },
  });
});

test("traceEvent writes ndjson when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-openai-trace-"));
  const file = join(dir, "trace.ndjson");
  process.env.CLAUDE_OPENAI_LOG = "true";
  process.env.CLAUDE_OPENAI_LOG_LEVEL = "debug";
  process.env.CLAUDE_OPENAI_LOG_FILE = file;

  traceEvent("test.event", { value: 1, access_token: "abc", input_tokens: 123 });

  const line = readFileSync(file, "utf8").trim();
  const parsed = JSON.parse(line) as { level: string; event: string; payload: unknown };
  expect(parsed.level).toBe("debug");
  expect(parsed.event).toBe("test.event");
  expect(parsed.payload).toEqual({ value: 1, access_token: "[REDACTED]", input_tokens: 123 });
  rmSync(dir, { recursive: true, force: true });
});

test("trace accepts boolean-style values and explicit levels", () => {
  process.env.CLAUDE_OPENAI_LOG = "yes";
  process.env.CLAUDE_OPENAI_LOG_LEVEL = "debug";
  expect(__test__.truthy(process.env.CLAUDE_OPENAI_LOG)).toBeTrue();
  expect(__test__.traceLevel()).toBe("debug");
});

test("trace defaults to debug and filters only trace details", () => {
  expect(__test__.traceLevel()).toBe("debug");
  expect(__test__.shouldLog("info")).toBeTrue();
  expect(__test__.shouldLog("debug")).toBeTrue();
  expect(__test__.shouldLog("trace")).toBeFalse();
});
