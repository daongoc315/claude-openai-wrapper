import { expect, test } from "bun:test";
import { ClaudeCliError, formatError, ValidationError } from "../errors.js";

test("formats validation errors", () => {
  expect(formatError(new ValidationError({ message: "bad input" }))).toContain("bad input");
});

test("formats classified Claude CLI errors", () => {
  const text = formatError(
    new ClaudeCliError({
      code: "CLAUDE_TIMEOUT",
      message: "timed out",
      durationMs: 123,
      stderr: "late",
    }),
  );

  expect(text).toContain("CLAUDE_TIMEOUT");
  expect(text).toContain("durationMs: 123");
  expect(text).toContain("stderr: late");
});
