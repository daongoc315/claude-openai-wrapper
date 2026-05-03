import { expect, test } from "bun:test";
import { CoreWrapper } from "../core/wrapper.js";
import type { ClaudeClient } from "../core/claude-client.js";
import { ClaudeCliError } from "../errors.js";
import { appConfig } from "../config.js";

test("CoreWrapper returns validation error when messages are missing", async () => {
  const wrapper = new CoreWrapper({
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  });

  const result = await wrapper.executeChatCompletion({ model: "claude-sonnet" });

  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error("Expected error result");
  expect(result.status).toBe(400);
  expect(result.body.error.message).toContain("messages must be a non-empty array");
});

test("CoreWrapper returns validation error for non-object input", async () => {
  const wrapper = new CoreWrapper({
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  });

  const result = await wrapper.executeChatCompletion("not-an-object" as unknown);

  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error("Expected error result");
  expect(result.status).toBe(400);
  expect(result.body.error.message).toContain("request body must be an object");
});

test("CoreWrapper returns context_length_exceeded when prompt bytes are too large", async () => {
  const wrapper = new CoreWrapper({
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  });

  const result = await wrapper.executeChatCompletion({
    model: "claude-sonnet",
    messages: [{ role: "user", content: "a".repeat(appConfig.maxPromptBytes + 1024) }],
  });

  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error("Expected error result");
  expect(result.status).toBe(413);
  expect(result.body.error.type).toBe("context_length_exceeded");
});

test("CoreWrapper returns validation error for invalid parameter types", async () => {
  const wrapper = new CoreWrapper({
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  });

  const badStream = await wrapper.executeChatCompletion({
    model: "claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
    stream: "yes" as unknown as boolean,
  });
  const badMaxTokens = await wrapper.executeChatCompletion({
    model: "claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: "100" as unknown as number,
  });

  expect(badStream.ok).toBeFalse();
  if (badStream.ok) throw new Error("Expected error result");
  expect(badStream.status).toBe(400);
  expect(badStream.body.error.message).toContain("stream must be a boolean");

  expect(badMaxTokens.ok).toBeFalse();
  if (badMaxTokens.ok) throw new Error("Expected error result");
  expect(badMaxTokens.status).toBe(400);
  expect(badMaxTokens.body.error.message).toContain("max_tokens must be a positive integer");
});

test("CoreWrapper returns non-stream response shape", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => ({ text: "final answer", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  };
  const wrapper = new CoreWrapper(fakeClient);

  const result = await wrapper.executeChatCompletion({
    model: "claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
  });

  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error("Expected success result");
  expect(result.body.object).toBe("chat.completion");
  expect(result.body.choices[0]!.message).toEqual({ role: "assistant", content: "final answer" });
  expect(result.body.choices[0]!.finish_reason).toBe("stop");
});

test("CoreWrapper streams chunks from injected Claude client", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async (_args, callbacks) => {
      await callbacks?.onText?.("hello", {}, 0);
      await callbacks?.onText?.(" world", {}, 1);
      return { text: "hello world", stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const wrapper = new CoreWrapper(fakeClient);
  const chunks: unknown[] = [];

  const result = await wrapper.executeChatCompletionStreaming(
    { model: "claude-sonnet", messages: [{ role: "user", content: "hello" }] },
    (chunk) => chunks.push(chunk),
  );

  expect(result.ok).toBeTrue();
  expect(chunks.length).toBe(4);
  expect((chunks[2] as { choices: { delta: { content?: string } }[] }).choices[0]!.delta.content).toBe(" world");
});

test("CoreWrapper streams OpenAI tool calls with indexes", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => ({
      text: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
      toolCalls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } }],
    }),
  };
  const wrapper = new CoreWrapper(fakeClient);
  const chunks: unknown[] = [];

  const result = await wrapper.executeChatCompletionStreaming(
    { model: "claude-sonnet", messages: [{ role: "user", content: "hello" }] },
    (chunk) => chunks.push(chunk),
  );

  expect(result.ok).toBeTrue();
  const toolDelta = (chunks[1] as { choices: { delta: { tool_calls?: unknown[] } }[] }).choices[0]!.delta.tool_calls;
  expect(toolDelta).toEqual([{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } }]);
});

test("CoreWrapper returns stream error before emitting chunks", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async () => {
      throw new Error("boom");
    },
  };
  const wrapper = new CoreWrapper(fakeClient);
  const chunks: unknown[] = [];

  const result = await wrapper.executeChatCompletionStreaming(
    { model: "claude-sonnet", messages: [{ role: "user", content: "hello" }] },
    (chunk) => chunks.push(chunk),
  );

  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error("Expected error result");
  expect(result.status).toBe(500);
  expect(result.body.error.type).toBe("internal_error");
  expect(chunks).toEqual([]);
});

test("CoreWrapper terminates stream cleanly on mid-stream errors", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
    executeStreaming: async (_args, callbacks) => {
      await callbacks?.onText?.("partial", {}, 0);
      throw new Error("boom");
    },
  };
  const wrapper = new CoreWrapper(fakeClient);
  const chunks: unknown[] = [];

  const result = await wrapper.executeChatCompletionStreaming(
    { model: "claude-sonnet", messages: [{ role: "user", content: "hello" }] },
    (chunk) => chunks.push(chunk),
  );

  expect(result.ok).toBeTrue();
  expect((chunks.at(-1) as { choices: { finish_reason: string | null }[] }).choices[0]!.finish_reason).toBe("stop");
  expect((chunks.at(-2) as { choices: { delta: { content?: string } }[] }).choices[0]!.delta.content).toBe("partial");
});

test("CoreWrapper maps ClaudeCliError QUEUE_FULL to OpenAI rate limit error", async () => {
  const fakeClient: ClaudeClient = {
    execute: async () => {
      throw new ClaudeCliError({ code: "QUEUE_FULL", message: "full" });
    },
    executeStreaming: async () => ({ text: "", stdout: "", stderr: "", exitCode: 0 }),
  };
  const wrapper = new CoreWrapper(fakeClient);

  const result = await wrapper.executeChatCompletion({
    model: "claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
  });

  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error("Expected error result");
  expect(result.status).toBe(429);
  expect(result.body.error.type).toBe("rate_limit_error");
  expect(result.body.error.message).toBe("full");
});
