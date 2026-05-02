import { Schema } from "effect";

const optionalStringArray = Schema.optional(Schema.Array(Schema.String));
const boundedString = Schema.String.pipe(Schema.maxLength(256));
const sessionIdString = Schema.String.pipe(Schema.maxLength(512));
const pathString = Schema.String.pipe(Schema.maxLength(4096));
export const SafePermissionModeSchema = Schema.Literal("acceptEdits", "auto", "default", "plan");
export const ToolModeSchema = Schema.Literal("disabled", "readonly", "safe", "all");

export const ClaudeArgsSchema = Schema.Struct({
  prompt: Schema.NonEmptyString,
  sessionId: Schema.optional(sessionIdString),
  isolated: Schema.optional(Schema.Boolean),
  resetSession: Schema.optional(Schema.Boolean),
  model: Schema.optional(boundedString),
  effort: Schema.optional(Schema.Literal("low", "medium", "high", "xhigh", "max")),
  workingDirectory: Schema.optional(pathString),
  permissionMode: Schema.optional(SafePermissionModeSchema),
  allowedTools: optionalStringArray,
  disallowedTools: optionalStringArray,
  tools: optionalStringArray,
  enableTools: Schema.optional(Schema.Boolean),
  toolMode: Schema.optional(ToolModeSchema),
  addDirs: optionalStringArray,
  bare: Schema.optional(Schema.Boolean),
});

type DecodedClaudeArgs = Schema.Schema.Type<typeof ClaudeArgsSchema>;
export type ClaudeArgs = DecodedClaudeArgs;
