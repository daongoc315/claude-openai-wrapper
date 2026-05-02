export const SERVER_NAME = "claude-openai-wrapper";
export const SERVER_VERSION = "0.1.1";

export interface ClaudeJsonOutput {
  readonly type?: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly session_id?: string;
  readonly model?: string;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly num_turns?: number;
  readonly usage?: unknown;
  readonly [key: string]: unknown;
}

export interface ClaudeStreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly session_id?: string;
  readonly message?: {
    readonly model?: string;
    readonly content?: readonly unknown[];
    readonly usage?: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface ClaudeStreamCallbacks {
  readonly onEvent?: (event: ClaudeStreamEvent, index: number) => void | Promise<void>;
  readonly onText?: (text: string, event: ClaudeStreamEvent, index: number) => void | Promise<void>;
}

export interface ClaudeRunOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ClaudeRunResult {
  readonly text: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly parsed?: ClaudeJsonOutput;
  readonly wrapperSessionId?: string;
  readonly claudeSessionId?: string;
  readonly usage?: unknown;
}

export interface SessionInfo {
  readonly id: string;
  readonly claudeSessionId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly turns: number;
  readonly messages: readonly SessionMessage[];
}

export interface SessionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: Date;
  readonly claudeSessionId?: string;
}
