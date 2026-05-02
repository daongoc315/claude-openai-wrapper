import { expect, test } from "bun:test";
import { CoreWrapper } from "../core/wrapper.js";
import type { ClaudeClient } from "../core/claude-client.js";

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
      callbacks?.onText?.("hello", {}, 0);
      callbacks?.onText?.(" world", {}, 1);
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
});
