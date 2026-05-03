import { expect, test } from "bun:test";
import { __test__ } from "../core/openai-tool-adapter.js";

const requirements = (entries: Array<[string, readonly string[], string?]>) => new Map(entries.map(([adapterName, required, originalName]) => [adapterName, { adapterName, originalName: originalName || adapterName, required }]));

const argsWithTool = (parameters: unknown) => ({
  prompt: "hi",
  openAITools: [{ type: "function", function: { name: "custom_tool", parameters } }],
});

test("zod schema is permissive so canUseTool can capture invalid model args", () => {
  const shape = __test__.zodShapeFromJsonSchema({
    type: "object",
    properties: {
      todos: { type: "array", items: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
      name: { type: "string" },
    },
    required: ["todos", "name"],
  });

  expect(shape.todos?.safeParse(undefined).success).toBeTrue();
  expect(shape.name?.safeParse(undefined).success).toBeTrue();
});

test("OpenAI tools are parsed and required fields come from JSON schema", () => {
  const definitions = __test__.openAIToolsFromArgs({
    prompt: "hi",
    openAITools: [{ type: "function", function: { name: "custom_tool", description: "Custom", parameters: { type: "object", required: ["foo"], properties: { foo: { type: "string" } } } } }],
  });

  expect(definitions).toEqual([{ originalName: "custom_tool", adapterName: "custom_tool", description: "Custom", parameters: { type: "object", required: ["foo"], properties: { foo: { type: "string" } } }, required: ["foo"] }]);
  expect(__test__.toolSchemaRequirementsFromArgs({ prompt: "hi", openAITools: [{ type: "function", function: { name: "custom_tool", parameters: { required: ["foo"] } } }] }).get("custom_tool")).toMatchObject({ adapterName: "custom_tool", originalName: "custom_tool", required: ["foo"] });
});

test("OpenAI tool names are validated instead of sanitized", () => {
  expect(__test__.validateOpenAIToolName("lookup_data-1")).toBe("lookup_data-1");
  expect(() => __test__.validateOpenAIToolName("custom.tool")).toThrow("OpenAI tool function name must match");
  expect(() => __test__.openAIToolsFromArgs({ prompt: "hi", openAITools: [{ type: "function", function: { name: "custom.tool" } }] })).toThrow("OpenAI tool function name must match");
});

test("mergeToolCall replaces initial empty stream input with full assistant input", () => {
  const toolRequirements = requirements([["skill", ["name"]]]);
  const captured = __test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__skill", input: {} }], toolRequirements).slice();

  __test__.mergeToolCall(captured, {
    id: "toolu_1",
    type: "function",
    function: { name: "skill", arguments: "{\"name\":\"feature-audit\"}" },
  }, toolRequirements);

  expect(captured).toEqual([{ id: "toolu_1", type: "function", function: { name: "skill", arguments: "{\"name\":\"feature-audit\"}" } }]);
});

test("tool calls are dropped according to dynamic OpenAI required schema", () => {
  const toolRequirements = requirements([
    ["read", ["filePath"]],
    ["bash", ["command"]],
    ["custom", ["foo"]],
  ]);

  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__read", input: {} }], toolRequirements)).toEqual([]);
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_2", name: "mcp__openai_tools__bash", input: {} }], toolRequirements)).toEqual([]);
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_3", name: "mcp__openai_tools__custom", input: {} }], toolRequirements)).toEqual([]);
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__read", input: { filePath: "packages/table/src/index.ts" } }], toolRequirements)).toEqual([
    { id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"filePath\":\"packages/table/src/index.ts\"}" } },
  ]);
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_3", name: "mcp__openai_tools__custom", input: { foo: "bar" } }], toolRequirements)).toEqual([
    { id: "toolu_3", type: "function", function: { name: "custom", arguments: "{\"foo\":\"bar\"}" } },
  ]);
});

test("tool input keeps only object input and does not infer required fields", () => {
  const filePath = { adapterName: "read", originalName: "read", required: ["filePath"] };
  expect(__test__.stripAdapterPrefix("mcp__openai_tools__lookup")).toBe("lookup");
  expect(__test__.toolInputObject({ path: "packages/table/src/index.ts" })).toEqual({ path: "packages/table/src/index.ts" });
  expect(__test__.toolInputObject("packages/table/src/implementations/index.ts")).toEqual({});
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__read", input: { path: "packages/table/src/index.ts" } }], requirements([["read", filePath.required]]))).toEqual([]);
});

test("final extraction rejects missing required", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(argsWithTool({ type: "object", required: ["name"], properties: { name: { type: "string" } } }));
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__custom_tool", input: {} }], reqs)).toEqual([]);
});

test("final extraction rejects wrong primitive type", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(argsWithTool({ type: "object", required: ["count"], properties: { count: { type: "number" } } }));
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__custom_tool", input: { count: "1" } }], reqs)).toEqual([]);
});

test("final extraction rejects invalid enum", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(argsWithTool({ type: "object", required: ["mode"], properties: { mode: { enum: ["read", "write"] } } }));
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__custom_tool", input: { mode: "delete" } }], reqs)).toEqual([]);
});

test("final extraction rejects nested missing required", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(
    argsWithTool({
      type: "object",
      required: ["config"],
      properties: {
        config: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
      },
    }),
  );
  expect(__test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__custom_tool", input: { config: {} } }], reqs)).toEqual([]);
});

test("final extraction accepts valid nested input", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(
    argsWithTool({
      type: "object",
      required: ["config"],
      properties: {
        config: {
          type: "object",
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
      },
    }),
  );
  expect(
    __test__.extractToolCallsFromContent([{ type: "tool_use", id: "toolu_1", name: "mcp__openai_tools__custom_tool", input: { config: { enabled: true } } }], reqs),
  ).toEqual([{ id: "toolu_1", type: "function", function: { name: "custom_tool", arguments: "{\"config\":{\"enabled\":true}}" } }]);
});

test("mergeToolCall does not accept invalid final args", () => {
  const reqs = __test__.toolSchemaRequirementsFromArgs(argsWithTool({ type: "object", required: ["count"], properties: { count: { type: "integer" } } }));
  const calls = [{ id: "toolu_1", type: "function" as const, function: { name: "custom_tool", arguments: "{\"count\":2}" } }];
  const merged = __test__.mergeToolCall(calls, { id: "toolu_1", type: "function", function: { name: "custom_tool", arguments: "{\"count\":2.5}" } }, reqs);
  expect(merged).toBeFalse();
  expect(calls).toEqual([{ id: "toolu_1", type: "function", function: { name: "custom_tool", arguments: "{\"count\":2}" } }]);
});
