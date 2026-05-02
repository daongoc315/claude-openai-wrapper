import { Effect } from "effect";
import { runClaude, runClaudeStreaming } from "../claude-cli.js";
import { appConfig } from "../config.js";
import type { ClaudeArgs } from "../schemas.js";
import type { ClaudeRunOptions, ClaudeRunResult, ClaudeStreamCallbacks } from "../types.js";
import { AgentSdkClaudeClient } from "./agent-sdk-client.js";

export interface ClaudeClient {
  execute(args: ClaudeArgs, options?: ClaudeRunOptions): Promise<ClaudeRunResult>;
  executeStreaming(args: ClaudeArgs, callbacks?: ClaudeStreamCallbacks, options?: ClaudeRunOptions): Promise<ClaudeRunResult>;
}

export class CliClaudeClient implements ClaudeClient {
  execute(args: ClaudeArgs, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return Effect.runPromise(runClaude(args, options));
  }

  executeStreaming(args: ClaudeArgs, callbacks: ClaudeStreamCallbacks = {}, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return Effect.runPromise(runClaudeStreaming(args, callbacks, options));
  }
}

export class DefaultClaudeClient implements ClaudeClient {
  private readonly delegate: ClaudeClient = appConfig.backend === "cli" ? new CliClaudeClient() : new AgentSdkClaudeClient();

  execute(args: ClaudeArgs, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return this.delegate.execute(args, options);
  }

  executeStreaming(args: ClaudeArgs, callbacks: ClaudeStreamCallbacks = {}, options: ClaudeRunOptions = {}): Promise<ClaudeRunResult> {
    return this.delegate.executeStreaming(args, callbacks, options);
  }
}
