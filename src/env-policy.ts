const TRUTHY_VALUES = new Set(["true", "1", "yes", "on"]);

export const isTruthy = (value: string | undefined): boolean => (value ? TRUTHY_VALUES.has(value) : false);

export const CLAUDE_ENV_ALLOWLIST = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "USERNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

export const filteredClaudeEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CLAUDE_ENV_ALLOWLIST.has(key)) env[key] = value;
  }
  return { ...env, ...overrides };
};

export const debugEnabled = (): boolean => isTruthy(process.env.CLAUDE_OPENAI_DEBUG) || isTruthy(process.env.DEBUG);
