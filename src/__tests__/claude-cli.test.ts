import { expect, test } from "bun:test";
import { buildClaudeArgs, normalizeModelName, parseClaudeStreamLine } from "../claude-cli.js";

test("buildClaudeArgs defaults to stream-json and accepts model aliases", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "haiku" });

  expect(args).toContain("--output-format");
  expect(args).toContain("stream-json");
  expect(args).toContain("--include-partial-messages");
  expect(args).toContain("--model");
  expect(args).toContain("haiku");
});

test("buildClaudeArgs supports sonnet and opus aliases", () => {
  expect(buildClaudeArgs({ prompt: "hi", model: "sonnet", stream: false })).toContain("sonnet");
  expect(buildClaudeArgs({ prompt: "hi", model: "opus", stream: false })).toContain("opus");
});

test("buildClaudeArgs normalizes legacy full model names to aliases", () => {
  expect(normalizeModelName("claude-3-5-haiku-latest")).toBe("haiku");
  expect(normalizeModelName("claude-sonnet-4-5")).toBe("sonnet");
  expect(normalizeModelName("claude-opus-4-1")).toBe("opus");
  expect(buildClaudeArgs({ prompt: "hi", model: "claude-3-5-haiku-latest" })).toContain("haiku");
});

test("buildClaudeArgs can disable streaming", () => {
  const args = buildClaudeArgs({ prompt: "hi", stream: false });

  expect(args).toContain("json");
  expect(args).not.toContain("stream-json");
  expect(args).not.toContain("--include-partial-messages");
});

test("parseClaudeStreamLine ignores non-json lines", () => {
  expect(parseClaudeStreamLine("not json")).toBeUndefined();
  expect(parseClaudeStreamLine("")).toBeUndefined();
});

test("parseClaudeStreamLine parses json events", () => {
  expect(parseClaudeStreamLine('{"type":"result","result":"ok"}')).toEqual({ type: "result", result: "ok" });
});
