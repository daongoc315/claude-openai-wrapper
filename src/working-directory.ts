import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { appConfig } from "./config.js";
import { ClaudeCliError } from "./errors.js";

const isWithinPrefix = (candidate: string, prefix: string): boolean => {
  const normalizedPrefix = resolve(prefix);
  return candidate === normalizedPrefix || candidate.startsWith(`${normalizedPrefix}${sep}`);
};

export const validateWorkingDirectory = async (cwd: string): Promise<string> => {
  const resolved = resolve(cwd);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new ClaudeCliError({ code: "CLAUDE_SPAWN_ERROR", message: `workingDirectory is not a directory: ${cwd}` });
  }
  await access(resolved, constants.R_OK | constants.X_OK);
  const real = await realpath(resolved);
  const allowedPrefixes = await Promise.all(appConfig.allowedWorkingDirectoryPrefixes.map((prefix) => realpath(resolve(prefix)).catch(() => resolve(prefix))));
  if (!allowedPrefixes.some((prefix) => isWithinPrefix(real, prefix))) {
    throw new ClaudeCliError({ code: "CLAUDE_SPAWN_ERROR", message: `workingDirectory is outside allowed prefixes: ${real}` });
  }
  return real;
};
