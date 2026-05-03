import { expect, test } from "bun:test";
import { __test__, chatCompletionResponse, messagesToPrompt, streamChunk, toClaudeArgs } from "../openai-adapter.js";

test("messagesToPrompt maps roles and content variants", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: "Follow project rules" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "text", text: "Hi" }, " there"] },
    { role: "tool", name: "search", content: [{ type: "text", text: "Found docs" }] },
    { role: "developer", content: "Keep answers concise" },
  ]);

  expect(prompt).toContain('<message role="system">\nFollow project rules\n</message>');
  expect(prompt).toContain('<message role="user">\nHello\n</message>');
  expect(prompt).toContain('<message role="assistant">\nHi\n there\n</message>');
  expect(prompt).toContain('<message role="tool" name="search">\nFound docs\n</message>');
  expect(prompt).toContain('<message role="developer">\nKeep answers concise\n</message>');
});

test("toClaudeArgs validates messages", () => {
  const noMessages = toClaudeArgs({ model: "claude-sonnet" });
  const emptyMessages = toClaudeArgs({ messages: [] });
  const blankContent = toClaudeArgs({ messages: [{ role: "user", content: "   " }] });

  expect("error" in noMessages).toBeTrue();
  expect("error" in emptyMessages).toBeTrue();
  expect("error" in blankContent).toBeTrue();
});

test("toClaudeArgs maps model names and prefers explicit claude overrides", () => {
  const sonnet = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], model: "claude-sonnet" });
  const haiku = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], model: "claude-3-5-haiku-latest" });
  const opus = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], model: "claude-opus" });
  const override = toClaudeArgs({
    messages: [{ role: "user", content: "hi" }],
    model: "claude-sonnet",
    claude: { model: "opus", sessionId: "override-session", permissionMode: "plan" },
    session_id: "outer-session",
  });

  if ("error" in sonnet || "error" in haiku || "error" in opus || "error" in override) {
    throw new Error("Expected valid Claude args");
  }

  expect(sonnet.model).toBe("sonnet");
  expect(haiku.model).toBe("haiku");
  expect(opus.model).toBe("opus");
  expect(override.model).toBe("opus");
  expect(override.sessionId).toBe("override-session");
  expect(override.permissionMode).toBe("plan");
});

test("toClaudeArgs disables tools by default and enables readonly tools when requested", () => {
  const disabled = toClaudeArgs({ messages: [{ role: "user", content: "hi" }] });
  const enabled = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], enable_tools: true });

  if ("error" in disabled || "error" in enabled) throw new Error("Expected valid Claude args");

  expect(disabled.enableTools).toBe(false);
  expect(disabled.tools).toEqual([]);
  expect(disabled.disallowedTools).toContain("Bash");
  expect(enabled.enableTools).toBe(true);
  expect(enabled.tools).toEqual(["Read", "Glob", "Grep"]);
  expect(enabled.allowedTools).toEqual(["Read", "Glob", "Grep"]);
});

test("toClaudeArgs resolves OpenAI tool_choice explicitly", () => {
  const tools = [
    { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
    { type: "function", function: { name: "search", parameters: { type: "object" } } },
  ];
  const disabled = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], tools, tool_choice: "none" });
  const forced = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "function", function: { name: "lookup" } } });
  const missingForced = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], tools, tool_choice: { type: "function", function: { name: "does_not_exist" } } });
  const invalid = toClaudeArgs({ messages: [{ role: "user", content: "hi" }], tool_choice: { type: "function", function: { name: "lookup" } } });

  if ("error" in disabled || "error" in forced) throw new Error("Expected valid Claude args");

  expect(disabled.enableTools).toBe(false);
  expect(disabled.openAITools).toBeUndefined();
  expect(forced.enableTools).toBe(true);
  expect(forced.openAITools).toEqual([tools[0]]);
  expect("error" in missingForced).toBeTrue();
  if ("error" in missingForced) {
    expect(missingForced.error.status).toBe(400);
    expect(missingForced.error.body.error.message).toContain("does_not_exist");
  }
  expect("error" in invalid).toBeTrue();
});

test("resolveToolStrategy separates tool policy from Claude args projection", () => {
  expect(__test__.resolveToolStrategy({ messages: [{ role: "user", content: "hi" }] })).toEqual({ kind: "disabled" });
  expect(__test__.resolveToolStrategy({ messages: [{ role: "user", content: "hi" }], enable_tools: true })).toEqual({ kind: "claudeMode", mode: "readonly" });
  expect(__test__.toolStrategyToClaudeArgs({ kind: "claudeMode", mode: "safe" })).toMatchObject({ enableTools: true, toolMode: "safe", allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"] });
});

test("streamChunk and chatCompletionResponse emit OpenAI-compatible shapes", () => {
  const chunk = streamChunk("chatcmpl_test", "claude-sonnet", { content: "hello" });
  const done = streamChunk("chatcmpl_test", "claude-sonnet", {}, "stop");
  const completion = chatCompletionResponse("chatcmpl_test", "claude-sonnet", "final answer");

  expect(chunk.object).toBe("chat.completion.chunk");
  expect(chunk.choices[0]).toEqual({ index: 0, delta: { content: "hello" }, finish_reason: null });
  expect(done.choices[0]!.finish_reason).toBe("stop");

  expect(completion.object).toBe("chat.completion");
  expect(completion.choices[0]!.message).toEqual({ role: "assistant", content: "final answer" });
  expect(completion.choices[0]!.finish_reason).toBe("stop");
});
