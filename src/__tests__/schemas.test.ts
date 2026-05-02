import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { ClaudeArgsSchema } from "../schemas.js";

test("ClaudeArgsSchema accepts required prompt and optional controls", async () => {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(ClaudeArgsSchema)({
      prompt: "hello",
      effort: "xhigh",
      model: "opus",
      isolated: true,
      permissionMode: "plan",
      allowedTools: ["Read", "Grep"],
    }),
  );

  expect(decoded.prompt).toBe("hello");
  expect(decoded.effort).toBe("xhigh");
  expect(decoded.model).toBe("opus");
  expect(decoded.isolated).toBe(true);
  expect(decoded.allowedTools).toEqual(["Read", "Grep"]);
});

test("ClaudeArgsSchema does not expose background or foreground controls", async () => {
  const decoded = await Effect.runPromise(Schema.decodeUnknown(ClaudeArgsSchema)({ prompt: "hello" }));

  expect("background" in decoded).toBe(false);
  expect("foreground" in decoded).toBe(false);
});

test("ClaudeArgsSchema accepts client-provided session ids", async () => {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(ClaudeArgsSchema)({
      prompt: "hello",
      sessionId: "opencode session/with spaces",
    }),
  );

  expect(decoded.sessionId).toBe("opencode session/with spaces");
});

test("ClaudeArgsSchema accepts empty optional strings from OpenAI-compatible clients", async () => {
  const decoded = await Effect.runPromise(
    Schema.decodeUnknown(ClaudeArgsSchema)({
      prompt: "hello",
      sessionId: "",
      workingDirectory: "",
    }),
  );

  expect(decoded.sessionId).toBe("");
  expect(decoded.workingDirectory).toBe("");
});

test("ClaudeArgsSchema rejects dangerous permission modes", async () => {
  await expect(
    Effect.runPromise(
      Schema.decodeUnknown(ClaudeArgsSchema)({
        prompt: "hello",
        permissionMode: "bypassPermissions",
      }),
    ),
  ).rejects.toThrow();
});

test("ClaudeArgsSchema rejects missing prompt", async () => {
  await expect(Effect.runPromise(Schema.decodeUnknown(ClaudeArgsSchema)({}))).rejects.toThrow();
});
