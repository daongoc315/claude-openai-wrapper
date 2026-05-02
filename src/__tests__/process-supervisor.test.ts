import { expect, test } from "bun:test";
import { __test__ } from "../process-supervisor.js";

test("classifies missing Claude binary", () => {
  const error = __test__.classifyExecaError({ code: "ENOENT", stderr: "missing" });

  expect(error.code).toBe("CLAUDE_NOT_FOUND");
  expect(error.stderr).toBe("missing");
});

test("classifies timeouts", () => {
  const error = __test__.classifyExecaError({ timedOut: true, durationMs: 1000 });

  expect(error.code).toBe("CLAUDE_TIMEOUT");
  expect(error.durationMs).toBe(1000);
});

test("classifies max buffer overflow", () => {
  const error = __test__.classifyExecaError({ isMaxBuffer: true, stdout: "x" });

  expect(error.code).toBe("CLAUDE_OUTPUT_TOO_LARGE");
});

test("classifies non-zero exits", () => {
  const error = __test__.classifyExecaError({ exitCode: 2, shortMessage: "nope", stderr: "bad" });

  expect(error.code).toBe("CLAUDE_NON_ZERO_EXIT");
  expect(error.exitCode).toBe(2);
  expect(error.stderr).toBe("bad");
});

test("splits complete lines and keeps trailing remainder", () => {
  expect(__test__.splitCompleteLines("a\nb\npartial")).toEqual({ lines: ["a", "b"], remainder: "partial" });
});

test("rejects working directories outside allowed prefixes", async () => {
  await expect(__test__.validateWorkingDirectory("/")).rejects.toThrow("outside allowed prefixes");
});
