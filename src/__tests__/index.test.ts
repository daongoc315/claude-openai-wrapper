import { expect, test } from "bun:test";
import { __test__ } from "../index.js";

test("parseArgs maps --version and -v to version command", () => {
  expect(__test__.parseArgs(["--version"]).command).toBe("version");
  expect(__test__.parseArgs(["-v"]).command).toBe("version");
});

test("parseArgs maps --help and -h to help command", () => {
  expect(__test__.parseArgs(["--help"]).command).toBe("help");
  expect(__test__.parseArgs(["-h"]).command).toBe("help");
});

test("parseArgs maps flat server flags to env", () => {
  expect(__test__.parseArgs(["--port", "9000", "--api-key=dev", "--backend", "sdk", "--log"]).env).toEqual({
    CLAUDE_OPENAI_PORT: "9000",
    CLAUDE_OPENAI_API_KEY: "dev",
    CLAUDE_OPENAI_BACKEND: "sdk",
    CLAUDE_OPENAI_LOG: "true",
  });
});

test("parseArgs supports advanced flat config flags", () => {
  expect(__test__.parseArgs(["--allowed-working-directory-prefixes", "/repo,/tmp", "--max-concurrency", "4", "--trace-file", "trace.ndjson"]).env).toEqual({
    CLAUDE_OPENAI_ALLOWED_WORKING_DIR_PREFIXES: "/repo,/tmp",
    CLAUDE_OPENAI_MAX_CONCURRENCY: "4",
    CLAUDE_OPENAI_TRACE_FILE: "trace.ndjson",
  });
});

test("parseArgs keeps trace aliases for protocol debugging", () => {
  expect(__test__.parseArgs(["--trace", "--trace-file", "trace.ndjson"]).env).toEqual({
    CLAUDE_OPENAI_TRACE: "true",
    CLAUDE_OPENAI_LOG_LEVEL: "trace",
    CLAUDE_OPENAI_TRACE_FILE: "trace.ndjson",
  });
});

test("parseArgs supports explicit boolean values and log levels", () => {
  expect(__test__.parseArgs(["--log=false", "--log-level", "debug"]).env).toEqual({
    CLAUDE_OPENAI_LOG: "false",
    CLAUDE_OPENAI_LOG_LEVEL: "debug",
  });
});
