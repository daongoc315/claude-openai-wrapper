import { createSdkMcpServer, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodType } from "zod";
import type { ClaudeArgs } from "../schemas.js";
import { traceEvent } from "../trace.js";
import type { OpenAIToolCallResult } from "../types.js";

const ADAPTER_SERVER_NAME = "openai_tools";
const ADAPTER_TOOL_PREFIX = `mcp__${ADAPTER_SERVER_NAME}__`;
const VALID_OPENAI_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ToolSchemaRequirement {
  readonly adapterName: string;
  readonly originalName: string;
  readonly required: readonly string[];
  readonly strictSchema?: ZodType;
}

export type ToolSchemaRequirements = ReadonlyMap<string, ToolSchemaRequirement>;

export interface OpenAIToolDefinition {
  readonly originalName: string;
  readonly adapterName: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly required: readonly string[];
}

export interface OpenAIToolAdapter {
  readonly mcpServers: NonNullable<Options["mcpServers"]>;
  readonly tools: string[];
}

export const validateOpenAIToolName = (name: string): string => {
  if (!VALID_OPENAI_TOOL_NAME.test(name)) {
    throw new Error(`OpenAI tool function name must match ${VALID_OPENAI_TOOL_NAME}: ${name}`);
  }
  return name;
};

export const stripAdapterPrefix = (name: string): string => (name.startsWith(ADAPTER_TOOL_PREFIX) ? name.slice(ADAPTER_TOOL_PREFIX.length) : name);

export const toolInputObject = (input: unknown): Record<string, unknown> => (input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {});

export const requiredFieldsFromJsonSchema = (schema: unknown): readonly string[] => {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [];
};

const requirementForTool = (toolName: string, requirements: ToolSchemaRequirements): ToolSchemaRequirement | undefined => requirements.get(toolName);

const hasRequiredFields = (toolName: string, input: Record<string, unknown>, requirements: ToolSchemaRequirements): boolean => {
  const required = requirementForTool(toolName, requirements)?.required || [];
  return required.every((key) => input[key] !== undefined && input[key] !== null);
};

const zodSubsetShapeFromJsonSchema = (schema: unknown): Record<string, ZodType> => {
  if (!schema || typeof schema !== "object") return {};
  const properties = (schema as { properties?: unknown }).properties;
  const entries = properties && typeof properties === "object" ? Object.entries(properties as Record<string, unknown>) : [];
  const required = new Set(requiredFieldsFromJsonSchema(schema));
  return Object.fromEntries(entries.map(([key, value]) => [key, required.has(key) ? zodSubsetFromJsonSchema(value) : zodSubsetFromJsonSchema(value).optional()]));
};

/**
 * Builds a Zod validator for only a conservative subset of OpenAI JSON Schema.
 *
 * Supported subset:
 * - primitive types: string, number, integer, boolean
 * - arrays via `items`
 * - objects via `properties`
 * - required object keys via `required`
 * - string enums via `enum`
 *
 * This is intentionally not full JSON Schema validation.
 */
const zodSubsetFromJsonSchema = (schema: unknown): ZodType => {
  if (!schema || typeof schema !== "object") return z.unknown();
  const record = schema as { type?: unknown; enum?: unknown; items?: unknown; properties?: unknown };
  if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string") && record.enum.length > 0) return z.enum(record.enum as [string, ...string[]]);
  if (record.type === "string") return z.string();
  if (record.type === "number") return z.number();
  if (record.type === "integer") return z.number().int();
  if (record.type === "boolean") return z.boolean();
  if (record.type === "array") return z.array(zodSubsetFromJsonSchema(record.items));
  if (record.type === "object" || record.properties) return z.object(zodSubsetShapeFromJsonSchema(schema)).passthrough();
  return z.unknown();
};

const hasValidFinalInput = (toolName: string, input: Record<string, unknown>, requirements: ToolSchemaRequirements): boolean => {
  const requirement = requirementForTool(toolName, requirements);
  if (requirement?.strictSchema) return requirement.strictSchema.safeParse(input).success;
  return hasRequiredFields(toolName, input, requirements);
};

const zodFromJsonSchema = (schema: unknown): ZodType => {
  if (!schema || typeof schema !== "object") return z.unknown();
  const record = schema as { type?: unknown; enum?: unknown; items?: unknown; properties?: unknown };
  if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string") && record.enum.length > 0) return z.enum(record.enum as [string, ...string[]]);
  const description = (schema as { description?: unknown }).description;
  const describe = (type: ZodType): ZodType => (typeof description === "string" && description ? type.describe(description) : type);
  if (record.type === "string") return describe(z.string());
  if (record.type === "number") return describe(z.number());
  if (record.type === "integer") return describe(z.number().int());
  if (record.type === "boolean") return describe(z.boolean());
  if (record.type === "array") return describe(z.array(zodFromJsonSchema(record.items)));
  if (record.type === "object" || record.properties) return describe(z.object(zodShapeFromJsonSchema(schema)).passthrough());
  return describe(z.unknown());
};

export const zodShapeFromJsonSchema = (schema: unknown): Record<string, ZodType> => {
  if (!schema || typeof schema !== "object") return {};
  const properties = (schema as { properties?: unknown }).properties;
  const entries = properties && typeof properties === "object" ? Object.entries(properties as Record<string, unknown>) : [];
  // Keep every property optional for the SDK MCP schema. Claude may initially
  // produce partial tool inputs; required fields are checked manually later so
  // incomplete calls can be captured/merged instead of rejected by Zod first.
  return Object.fromEntries(entries.map(([key, value]) => [key, zodFromJsonSchema(value).optional()]));
};

export const openAIToolsFromArgs = (args: ClaudeArgs): readonly OpenAIToolDefinition[] => {
  if (!args.openAITools?.length) return [];
  const definitions = args.openAITools.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as { type?: unknown; function?: unknown };
    if (record.type !== "function" || !record.function || typeof record.function !== "object") return [];
    const fn = record.function as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof fn.name !== "string" || !fn.name) return [];
    const name = validateOpenAIToolName(fn.name);
    return [{ originalName: name, adapterName: name, description: typeof fn.description === "string" ? fn.description : `OpenAI function ${name}`, parameters: fn.parameters, required: requiredFieldsFromJsonSchema(fn.parameters) }];
  });
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.adapterName)) throw new Error(`Duplicate OpenAI tool function name: ${definition.originalName}`);
    seen.add(definition.adapterName);
  }
  return definitions;
};

export const toolSchemaRequirementsFromArgs = (args: ClaudeArgs): ToolSchemaRequirements =>
  new Map(
    openAIToolsFromArgs(args).map((definition) => [
      definition.adapterName,
      {
        adapterName: definition.adapterName,
        originalName: definition.originalName,
        required: definition.required,
        strictSchema: zodSubsetFromJsonSchema(definition.parameters),
      },
    ]),
  );

export const createOpenAIToolAdapter = (args: ClaudeArgs): OpenAIToolAdapter | undefined => {
  const definitions = openAIToolsFromArgs(args);
  if (!definitions.length) return undefined;
  const sdkTools = definitions.map((definition) =>
    tool(definition.adapterName, definition.description, zodShapeFromJsonSchema(definition.parameters), async (toolArgs) => ({
      content: [{ type: "text", text: JSON.stringify({ captured: true, tool: definition.originalName, arguments: toolArgs ?? {} }) }],
    })),
  );
  return {
    mcpServers: { [ADAPTER_SERVER_NAME]: createSdkMcpServer({ name: ADAPTER_SERVER_NAME, version: "1.0.0", tools: sdkTools, alwaysLoad: true }) },
    tools: definitions.map((definition) => `${ADAPTER_TOOL_PREFIX}${definition.adapterName}`),
  };
};

export const toolCallFromBlock = (block: unknown, requirements: ToolSchemaRequirements = new Map()): OpenAIToolCallResult | undefined => {
  if (!block || typeof block !== "object") return undefined;
  const record = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
  if (record.type !== "tool_use" || typeof record.id !== "string" || typeof record.name !== "string") return undefined;
  const name = stripAdapterPrefix(record.name);
  const requirement = requirementForTool(name, requirements);
  const input = toolInputObject(record.input);
  if (!hasValidFinalInput(name, input, requirements)) {
    traceEvent("sdk.drop_incomplete_tool_call", { id: record.id, name, input: record.input }, "debug");
    return undefined;
  }
  const responseName = requirement?.originalName || name;
  return { id: record.id, type: "function", function: { name: responseName, arguments: JSON.stringify(input) } };
};

export const extractToolCallsFromContent = (content: unknown, requirements: ToolSchemaRequirements = new Map()): readonly OpenAIToolCallResult[] => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const call = toolCallFromBlock(block, requirements);
    return call ? [call] : [];
  });
};

export const extractToolCallsFromSdkMessage = (message: SDKMessage, requirements: ToolSchemaRequirements = new Map()): readonly OpenAIToolCallResult[] => {
  if (message.type === "assistant") return extractToolCallsFromContent(message.message.content, requirements);
  if (message.type !== "stream_event") return [];
  const event = message.event as { type?: unknown; content_block?: unknown };
  return event.type === "content_block_start" ? extractToolCallsFromContent([event.content_block], requirements) : [];
};

const parseToolArguments = (toolCall: OpenAIToolCallResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const mergeToolCall = (toolCalls: OpenAIToolCallResult[], next: OpenAIToolCallResult, requirements: ToolSchemaRequirements = new Map()): boolean => {
  const requirement = [...requirements.values()].find((candidate) => candidate.originalName === next.function.name || candidate.adapterName === next.function.name);
  const requiredToolName = requirement?.adapterName || next.function.name;
  if (!hasValidFinalInput(requiredToolName, parseToolArguments(next), requirements)) return false;
  const index = toolCalls.findIndex((existing) => existing.id === next.id);
  if (index === -1) {
    toolCalls.push(next);
    return true;
  }
  const existingArgs = toolCalls[index]?.function.arguments || "{}";
  if (existingArgs === "{}" || next.function.arguments !== "{}") {
    toolCalls[index] = next;
    return true;
  }
  return false;
};

export const createCapturedToolCallFromRequirements = (toolName: string, toolUseID: string, input: unknown, requirements: ToolSchemaRequirements): OpenAIToolCallResult => {
  const adapterName = stripAdapterPrefix(toolName);
  const requirement = requirementForTool(adapterName, requirements);
  const responseName = requirement?.originalName || adapterName;
  return { id: toolUseID, type: "function", function: { name: responseName, arguments: JSON.stringify(toolInputObject(input)) } };
};

export const __test__ = {
  createCapturedToolCallFromRequirements,
  extractToolCallsFromContent,
  extractToolCallsFromSdkMessage,
  mergeToolCall,
  openAIToolsFromArgs,
  requiredFieldsFromJsonSchema,
  stripAdapterPrefix,
  toolInputObject,
  toolSchemaRequirementsFromArgs,
  validateOpenAIToolName,
  zodShapeFromJsonSchema,
};
