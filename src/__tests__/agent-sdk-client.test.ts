import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../core/agent-sdk-client.js";

test("normalizePermissionMode sanitizes unsupported modes", () => {
  expect(__test__.normalizePermissionMode(undefined)).toBe("default");
  expect(__test__.normalizePermissionMode("default")).toBe("default");
  expect(__test__.normalizePermissionMode("auto")).toBe("acceptEdits");
  expect(__test__.normalizePermissionMode("plan")).toBe("plan");
  expect(__test__.normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
  expect(__test__.normalizePermissionMode("bypassPermissions" as never)).toBe("default");
});

test("assertSdkSafety rejects bypassPermissions by default", async () => {
  delete process.env.CLAUDE_OPENAI_ALLOW_BYPASS_PERMISSIONS;
  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      permissionMode: "bypassPermissions" as never,
    }),
  ).rejects.toThrow("bypassPermissions is not allowed");
});

test("assertSdkSafety rejects explicit tools unless opt-in", async () => {
  delete process.env.CLAUDE_OPENAI_ALLOW_EXPLICIT_TOOLS;
  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      tools: ["Bash"],
    }),
  ).rejects.toThrow("explicit tools are disabled");
});

test("assertSdkSafety validates addDirs and workingDirectory prefixes", async () => {
  const safeDir = join(process.cwd(), ".tmp-agent-sdk-safe");
  await mkdir(safeDir, { recursive: true });
  const outsideDir = join(tmpdir(), "agent-sdk-outside");
  await mkdir(outsideDir, { recursive: true });

  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      workingDirectory: safeDir,
      addDirs: [safeDir],
    }),
  ).resolves.toBeDefined();

  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      workingDirectory: outsideDir,
    }),
  ).rejects.toThrow("outside allowed prefixes");
});

test("buildOptions blocks tools without dropping existing Claude Code login", () => {
  const previous = process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
  const controller = new AbortController();
  const options = __test__.buildOptions({ prompt: "hi", enableTools: false }, controller);

  expect(options.tools).toEqual([]);
  expect(options.allowedTools).toEqual([]);
  expect(options.mcpServers).toEqual({});
  expect(options.strictMcpConfig).toBe(true);
  expect(options.settingSources).toEqual([]);
  expect(options.permissionMode).toBe("dontAsk");
  expect(options.systemPrompt).toBe("");
  expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  expect(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("claude-code");
  if (previous === undefined) delete process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR = previous;
});

test("buildOptions can override Claude config dir when explicitly requested", () => {
  const previous = process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR = "/tmp/custom-claude-config";
  const options = __test__.buildOptions({ prompt: "hi", enableTools: false }, new AbortController());

  expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/custom-claude-config");
  expect(__test__.claudeConfigDirOverride()).toBe("/tmp/custom-claude-config");

  if (previous === undefined) delete process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_OPENAI_CLAUDE_CONFIG_DIR = previous;
});

test("sdkClientApp defaults to claude-code and can be overridden", () => {
  const previous = process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP;
  delete process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP;
  expect(__test__.sdkClientApp()).toBe("claude-code");
  process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP = "custom-client";
  expect(__test__.sdkClientApp()).toBe("custom-client");
  if (previous === undefined) delete process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP;
  else process.env.CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP = previous;
});

test("buildOptions adapts OpenAI function tools into SDK tools", () => {
  const captured: unknown[] = [];
  const options = __test__.buildOptions(
    {
      prompt: "use lookup",
      enableTools: true,
      openAITools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up data",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        },
      ],
    },
    new AbortController(),
    captured as never,
  );

  expect(options.maxTurns).toBe(1);
  expect(options.mcpServers).toHaveProperty("openai_tools");
  expect(options.tools).toEqual(["mcp__openai_tools__lookup"]);
  expect(typeof options.canUseTool).toBe("function");
});

test("canUseTool captures SDK tool use as OpenAI tool call and interrupts execution", async () => {
  const captured: unknown[] = [];
  const options = __test__.buildOptions(
    {
      prompt: "update todos",
      enableTools: true,
      openAITools: [
        {
          type: "function",
          function: {
            name: "todowrite",
            description: "Update todos",
            parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: {} } } }, required: ["todos"] },
          },
        },
      ],
    },
    new AbortController(),
    captured as never,
  );

  const decision = await options.canUseTool?.("mcp__openai_tools__todowrite", { todos: [] }, { signal: new AbortController().signal, toolUseID: "toolu_1" });

  expect(decision).toEqual({ behavior: "deny", message: "Tool call captured.", interrupt: true, toolUseID: "toolu_1" });
  expect(captured).toEqual([{ id: "toolu_1", type: "function", function: { name: "todowrite", arguments: "{\"todos\":[]}" } }]);
});

test("canUseTool ignores non-adapter tools and does not capture incomplete adapter calls", async () => {
  const captured: unknown[] = [];
  const options = __test__.buildOptions(
    {
      prompt: "update todos",
      openAITools: [{ type: "function", function: { name: "todowrite", parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] } } }],
    },
    new AbortController(),
    captured as never,
  );

  const nonAdapter = await options.canUseTool?.("mcp__other__todowrite", { todos: [] }, { signal: new AbortController().signal, toolUseID: "toolu_other" });
  const incomplete = await options.canUseTool?.("mcp__openai_tools__todowrite", {}, { signal: new AbortController().signal, toolUseID: "toolu_empty" });

  expect(nonAdapter).toEqual({ behavior: "deny", message: "Tool is not part of the OpenAI adapter: mcp__other__todowrite", toolUseID: "toolu_other" });
  expect(incomplete).toEqual({ behavior: "deny", message: "Tool call is incomplete for its OpenAI schema; retry with required arguments.", toolUseID: "toolu_empty" });
  expect(captured).toEqual([]);
});

test("session execution lock serializes matching session ids", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const first = __test__.withSessionExecutionLock("ses_same", async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
    return "first";
  });

  await Promise.resolve();

  const second = __test__.withSessionExecutionLock("ses_same", async () => {
    events.push("second:start");
    return "second";
  });

  await Promise.resolve();
  expect(events).toEqual(["first:start"]);

  releaseFirst();
  await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
  expect(events).toEqual(["first:start", "first:end", "second:start"]);
});

test("session execution lock allows different session ids concurrently", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const first = __test__.withSessionExecutionLock("ses_a", async () => {
    events.push("a:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    events.push("a:end");
  });

  await Promise.resolve();
  const second = __test__.withSessionExecutionLock("ses_b", async () => {
    events.push("b:start");
  });

  await second;
  expect(events).toEqual(["a:start", "b:start"]);
  releaseFirst();
  await first;
});
