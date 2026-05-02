import { execa, type ExecaError } from "execa";
import PQueue, { TimeoutError } from "p-queue";
import { E_TIMEOUT, Mutex, withTimeout } from "async-mutex";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { appConfig, truncate } from "./config.js";
import { ClaudeCliError } from "./errors.js";
import { appendRunEvent, appendRunOutput, cancelRegistryRun, listRegistryRuns, outputPathFor, updateRun, writeRun, type RegistryRun } from "./run-registry.js";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface ProcessRunOptions {
  readonly cwd?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly label?: string | undefined;
  readonly promptPreview?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface StreamingProcessRunOptions extends ProcessRunOptions {
  readonly onStdoutLine?: (line: string) => void | Promise<void>;
  readonly onStderrLine?: (line: string) => void | Promise<void>;
  readonly beforeStart?: () => void | Promise<void>;
  readonly onSuccessfulExit?: () => void | Promise<void>;
}

let shuttingDown = false;
const activeControllers = new Set<AbortController>();
const sessionLocks = new Map<string, Mutex>();
const activeRuns = new Map<string, ActiveRunInternal>();
let backgroundStartReservations = 0;

interface ActiveRunInternal {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly pid?: number;
  readonly label?: string;
  readonly sessionId?: string;
  readonly outputPath?: string;
  readonly promptPreview?: string;
  readonly startedAt: number;
  readonly controller: AbortController;
}

export interface ActiveRunInfo {
  readonly id: string;
  readonly command: string;
  readonly status: RegistryRun["status"];
  readonly pid?: number;
  readonly outputPath?: string;
  readonly label?: string;
  readonly sessionId?: string;
  readonly promptPreview?: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
}

export interface BackgroundRunInfo extends ActiveRunInfo {
  readonly outputPath: string;
}

export const claudeQueue = new PQueue({
  concurrency: appConfig.maxConcurrentClaudeProcesses,
  intervalCap: appConfig.queueIntervalCap,
  interval: appConfig.queueIntervalMs,
  timeout: appConfig.queueTaskTimeoutMs,
});

const getSessionLock = (sessionId: string): Mutex => {
  const existing = sessionLocks.get(sessionId);
  if (existing) return existing;
  const mutex = new Mutex();
  sessionLocks.set(sessionId, mutex);
  return mutex;
};

export const releaseSessionLock = (sessionId: string): void => {
  const lock = sessionLocks.get(sessionId);
  if (!lock || !lock.isLocked()) sessionLocks.delete(sessionId);
};

export const cleanupIdleSessionLocks = (activeSessionIds: ReadonlySet<string>): number => {
  let deleted = 0;
  for (const [sessionId, lock] of sessionLocks) {
    if (!activeSessionIds.has(sessionId) && !lock.isLocked()) {
      sessionLocks.delete(sessionId);
      deleted += 1;
    }
  }
  return deleted;
};

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

const inFlightCount = (): number => activeRuns.size + backgroundStartReservations + claudeQueue.size + claudeQueue.pending;
const activeClaudeProcessCount = (): number => activeRuns.size + backgroundStartReservations + claudeQueue.pending;

const envAllowlist = new Set([
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

const subprocessEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (envAllowlist.has(key)) env[key] = value;
  }
  return env;
};

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

const normalizeRunOptions = async <T extends ProcessRunOptions>(options: T): Promise<T> => {
  if (!options.cwd) return options;
  const cwd = await validateWorkingDirectory(options.cwd);
  return { ...options, cwd };
};

const createController = (signal?: AbortSignal): AbortController => {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
};

const registerRun = (command: string, args: readonly string[], options: ProcessRunOptions, controller: AbortController): string => {
  const id = randomUUID();
  activeRuns.set(id, {
    id,
    command,
    args,
    ...(options.label ? { label: options.label } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.promptPreview ? { promptPreview: options.promptPreview } : {}),
    startedAt: Date.now(),
    controller,
  });
  return id;
};

export const listActiveRuns = (): readonly ActiveRunInfo[] =>
  [...activeRuns.values()].map((run) => ({
    id: run.id,
    command: run.command,
    status: "running",
    ...(run.pid ? { pid: run.pid } : {}),
    outputPath: outputPathFor(run.id, run.outputPath),
    ...(run.label ? { label: run.label } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.promptPreview ? { promptPreview: run.promptPreview } : {}),
    startedAt: new Date(run.startedAt).toISOString(),
    elapsedMs: Date.now() - run.startedAt,
  }));

const persistRunStart = async (id: string, workspace?: string): Promise<void> => {
  const run = activeRuns.get(id);
  if (!run) return;
  const now = new Date().toISOString();
  await writeRun({
    id: run.id,
    serverPid: process.pid,
    ...(run.pid ? { claudePid: run.pid } : {}),
    ...(workspace ? { workspace } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.label ? { label: run.label } : {}),
    ...(run.promptPreview ? { promptPreview: run.promptPreview } : {}),
    command: run.command,
    outputPath: outputPathFor(run.id, run.outputPath),
    startedAt: now,
    updatedAt: now,
    status: "running",
  });
};

const persistRunPid = async (id: string, pid: number | undefined): Promise<void> => {
  const run = activeRuns.get(id);
  if (run && pid) activeRuns.set(id, { ...run, pid });
  if (pid) await updateRun(id, { claudePid: pid });
};

const persistRunEnd = async (id: string, status: RegistryRun["status"]): Promise<void> => {
  const outputPath = activeRuns.get(id)?.outputPath;
  await appendRunEvent(id, "run_end", { status }, outputPath);
  await updateRun(id, { status });
};

export const listAllRuns = async (): Promise<readonly ActiveRunInfo[]> => {
  const local = listActiveRuns();
  const localIds = new Set(local.map((run) => run.id));
  const registry = await listRegistryRuns();
  const remote = registry
    .filter((run) => !localIds.has(run.id))
    .map((run) => ({
      id: run.id,
      command: run.command,
      status: run.status,
      ...(run.claudePid ? { pid: run.claudePid } : {}),
      outputPath: run.outputPath,
      ...(run.label ? { label: run.label } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.promptPreview ? { promptPreview: run.promptPreview } : {}),
      startedAt: run.startedAt,
      elapsedMs: Date.now() - new Date(run.startedAt).getTime(),
    }));
  return [...local, ...remote].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

export const cancelActiveRun = (id: string): boolean => {
  const run = activeRuns.get(id);
  if (!run) return false;
  run.controller.abort(new Error(`Canceled run ${id}`));
  return true;
};

export const cancelAnyRun = async (id: string): Promise<boolean> => cancelActiveRun(id) || (await cancelRegistryRun(id));

const classifyExecaError = (error: unknown): ClaudeCliError => {
  const execaError = error as Partial<ExecaError> & { code?: string; signal?: string; durationMs?: number };
  const stderr = truncate(typeof execaError.stderr === "string" ? execaError.stderr : undefined);
  const stdout = truncate(typeof execaError.stdout === "string" ? execaError.stdout : undefined);

  if (execaError.code === "ENOENT") {
    return new ClaudeCliError({
      code: "CLAUDE_NOT_FOUND",
      message: "Claude CLI not found. Install Claude Code or set CLAUDE_COMMAND to an absolute path.",
      stderr,
      stdout,
      durationMs: execaError.durationMs,
    });
  }
  if (execaError.timedOut) {
    return new ClaudeCliError({ code: "CLAUDE_TIMEOUT", message: "Claude process timed out", stderr, stdout, durationMs: execaError.durationMs });
  }
  if (execaError.isMaxBuffer) {
    return new ClaudeCliError({
      code: "CLAUDE_OUTPUT_TOO_LARGE",
      message: "Claude output exceeded configured max buffer",
      stderr,
      stdout,
      durationMs: execaError.durationMs,
    });
  }
  if (execaError.isCanceled) {
    return new ClaudeCliError({ code: "CLAUDE_CANCELED", message: "Claude process was canceled", stderr, stdout, durationMs: execaError.durationMs });
  }
  if (typeof execaError.exitCode === "number" && execaError.exitCode !== 0) {
    return new ClaudeCliError({
      code: "CLAUDE_NON_ZERO_EXIT",
      message: execaError.shortMessage ?? "Claude exited with non-zero status",
      exitCode: execaError.exitCode,
      signal: execaError.signal,
      stderr,
      stdout,
      durationMs: execaError.durationMs,
    });
  }
  return new ClaudeCliError({
    code: "CLAUDE_SPAWN_ERROR",
    message: error instanceof Error ? error.message : String(error),
    stderr,
    stdout,
    durationMs: execaError.durationMs,
  });
};

const splitCompleteLines = (buffer: string): { readonly lines: readonly string[]; readonly remainder: string } => {
  const parts = buffer.split(/\r?\n/);
  const remainder = parts.pop() ?? "";
  return { lines: parts, remainder };
};

const readLines = async (
  stream: AsyncIterable<Buffer | string> | null | undefined,
  onLine: ((line: string) => void | Promise<void>) | undefined,
  onOutputTooLarge?: () => void,
): Promise<string> => {
  if (!stream) return "";
  let output = "";
  let buffer = "";
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    output += text;
    if (byteLength(output) > appConfig.maxOutputBytes) {
      onOutputTooLarge?.();
      throw new ClaudeCliError({
        code: "CLAUDE_OUTPUT_TOO_LARGE",
        message: "Claude output exceeded configured output limit",
        stdout: truncate(output),
      });
    }
    buffer += text;
    const { lines, remainder } = splitCompleteLines(buffer);
    buffer = remainder;
    if (onLine) {
      for (const line of lines) await onLine(line);
    }
  }
  if (buffer && onLine) await onLine(buffer);
  return output;
};

const appendClaudeResultEventIfPresent = async (runId: string, line: string, outputPath?: string): Promise<void> => {
  try {
    const event = JSON.parse(line) as { type?: unknown; terminal_reason?: unknown; session_id?: unknown; is_error?: unknown; subtype?: unknown };
    if (event.type !== "result") return;
    await appendRunEvent(
      runId,
      "claude_result",
      {
        ...(typeof event.terminal_reason === "string" ? { terminalReason: event.terminal_reason } : {}),
        ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
        ...(typeof event.is_error === "boolean" ? { isError: event.is_error } : {}),
        ...(typeof event.subtype === "string" ? { subtype: event.subtype } : {}),
      },
      outputPath,
    );
  } catch {
    return;
  }
};

export const __test__ = {
  classifyExecaError,
  splitCompleteLines,
  validateWorkingDirectory,
};

const runDirect = async (command: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> => {
  const normalizedOptions = await normalizeRunOptions(options);
  const controller = createController(options.signal);
  activeControllers.add(controller);
  const runId = registerRun(command, args, normalizedOptions, controller);
  const started = Date.now();
  try {
    await persistRunStart(runId, normalizedOptions.cwd);
    const result = await execa(command, [...args], {
      ...(normalizedOptions.cwd ? { cwd: normalizedOptions.cwd } : {}),
      env: subprocessEnv(),
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: appConfig.processTimeoutMs,
      forceKillAfterDelay: appConfig.killGracePeriodMs,
      maxBuffer: appConfig.maxOutputBytes,
      cancelSignal: controller.signal,
      reject: false,
      stripFinalNewline: false,
    });
    const stdout = result.stdout;
    const stderr = result.stderr;
    if (byteLength(stdout) > appConfig.maxOutputBytes || byteLength(stderr) > appConfig.maxOutputBytes) {
      throw new ClaudeCliError({
        code: "CLAUDE_OUTPUT_TOO_LARGE",
        message: "Claude output exceeded configured output limit",
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
      });
    }
    if (result.exitCode !== 0) {
      throw new ClaudeCliError({
        code: "CLAUDE_NON_ZERO_EXIT",
        message: result.failed && result.shortMessage ? result.shortMessage : "Claude exited with non-zero status",
        exitCode: result.exitCode,
        stderr: truncate(stderr),
        stdout: truncate(stdout),
        durationMs: result.durationMs,
      });
    }
    await persistRunEnd(runId, "completed");
    return { stdout, stderr, exitCode: result.exitCode, durationMs: result.durationMs };
  } catch (error) {
    await persistRunEnd(runId, error instanceof ClaudeCliError && error.code === "CLAUDE_CANCELED" ? "canceled" : "failed");
    if (error instanceof ClaudeCliError) throw error;
    throw classifyExecaError(error);
  } finally {
    activeRuns.delete(runId);
    activeControllers.delete(controller);
  }
};

const runDirectStreaming = async (command: string, args: readonly string[], options: StreamingProcessRunOptions): Promise<ProcessResult> => {
  const normalizedOptions = await normalizeRunOptions(options);
  const controller = createController(options.signal);
  activeControllers.add(controller);
  const runId = registerRun(command, args, normalizedOptions, controller);
  const started = Date.now();
  try {
    await persistRunStart(runId, normalizedOptions.cwd);
    const subprocess = execa(command, [...args], {
      ...(normalizedOptions.cwd ? { cwd: normalizedOptions.cwd } : {}),
      env: subprocessEnv(),
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
      timeout: appConfig.processTimeoutMs,
      forceKillAfterDelay: appConfig.killGracePeriodMs,
      maxBuffer: appConfig.maxOutputBytes,
      cancelSignal: controller.signal,
      reject: false,
      stripFinalNewline: false,
    });
    await persistRunPid(runId, subprocess.pid);

    const [stdout, stderr, result] = await Promise.all([
      readLines(subprocess.stdout, async (line) => {
        await appendRunOutput(runId, "stdout", line, options.outputPath);
        await appendClaudeResultEventIfPresent(runId, line, options.outputPath);
        await options.onStdoutLine?.(line);
      }, () => controller.abort()),
      readLines(subprocess.stderr, async (line) => {
        await appendRunOutput(runId, "stderr", line, options.outputPath);
        await options.onStderrLine?.(line);
      }, () => controller.abort()),
      subprocess,
    ]);

    if (byteLength(stdout) > appConfig.maxOutputBytes || byteLength(stderr) > appConfig.maxOutputBytes) {
      throw new ClaudeCliError({
        code: "CLAUDE_OUTPUT_TOO_LARGE",
        message: "Claude output exceeded configured output limit",
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
      });
    }
    if (result.exitCode !== 0) {
      throw new ClaudeCliError({
        code: "CLAUDE_NON_ZERO_EXIT",
        message: result.failed && result.shortMessage ? result.shortMessage : "Claude exited with non-zero status",
        exitCode: result.exitCode,
        stderr: truncate(stderr),
        stdout: truncate(stdout),
        durationMs: result.durationMs,
      });
    }
    await persistRunEnd(runId, "completed");
    return { stdout, stderr, exitCode: result.exitCode, durationMs: result.durationMs };
  } catch (error) {
    await persistRunEnd(runId, error instanceof ClaudeCliError && error.code === "CLAUDE_CANCELED" ? "canceled" : "failed");
    if (error instanceof ClaudeCliError) throw error;
    throw classifyExecaError(error);
  } finally {
    activeRuns.delete(runId);
    activeControllers.delete(controller);
  }
};

export const startBackgroundStreamingProcess = async (
  command: string,
  args: readonly string[],
  options: StreamingProcessRunOptions,
): Promise<BackgroundRunInfo> => {
  if (shuttingDown) throw new ClaudeCliError({ code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" });
  if (inFlightCount() >= appConfig.maxQueueSize) {
    throw new ClaudeCliError({ code: "QUEUE_FULL", message: `Too many active or pending Claude requests (${inFlightCount()})` });
  }
  if (activeClaudeProcessCount() >= appConfig.maxConcurrentClaudeProcesses) {
    throw new ClaudeCliError({ code: "QUEUE_FULL", message: `Too many active Claude processes (${activeClaudeProcessCount()})` });
  }

  backgroundStartReservations += 1;

  let releaseSession: (() => void) | undefined;
  let runId: string | undefined;
  try {
    const normalizedOptions = await normalizeRunOptions(options);
    if (normalizedOptions.sessionId) {
      const lock = getSessionLock(normalizedOptions.sessionId);
      if (lock.isLocked()) {
        throw new ClaudeCliError({ code: "SESSION_LOCK_TIMEOUT", message: `Session already has an active Claude run: ${normalizedOptions.sessionId}` });
      }
      releaseSession = await lock.acquire();
    }
    await normalizedOptions.beforeStart?.();
    const controller = createController(options.signal);
    activeControllers.add(controller);
    runId = registerRun(command, args, normalizedOptions, controller);
    backgroundStartReservations -= 1;
    await persistRunStart(runId, normalizedOptions.cwd);
    const subprocess = execa(command, [...args], {
      ...(normalizedOptions.cwd ? { cwd: normalizedOptions.cwd } : {}),
      env: subprocessEnv(),
      shell: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
      timeout: appConfig.processTimeoutMs,
      forceKillAfterDelay: appConfig.killGracePeriodMs,
      maxBuffer: appConfig.maxOutputBytes,
      cancelSignal: controller.signal,
      reject: false,
      stripFinalNewline: false,
    });
    await persistRunPid(runId, subprocess.pid);
    const startedRunId = runId;

    void Promise.all([
      readLines(subprocess.stdout, async (line) => {
        await appendRunOutput(startedRunId, "stdout", line, normalizedOptions.outputPath);
        await appendClaudeResultEventIfPresent(startedRunId, line, normalizedOptions.outputPath);
        await options.onStdoutLine?.(line);
      }, () => controller.abort()),
      readLines(subprocess.stderr, async (line) => {
        await appendRunOutput(startedRunId, "stderr", line, normalizedOptions.outputPath);
        await options.onStderrLine?.(line);
      }, () => controller.abort()),
      subprocess,
    ])
      .then(async ([, , result]) => {
        if (result.exitCode === 0) await options.onSuccessfulExit?.();
        await persistRunEnd(startedRunId, result.exitCode === 0 ? "completed" : "failed");
      })
      .catch(async (error: unknown) => {
        const classified = error instanceof ClaudeCliError ? error : classifyExecaError(error);
        await persistRunEnd(startedRunId, classified.code === "CLAUDE_CANCELED" ? "canceled" : "failed");
      })
      .finally(() => {
        releaseSession?.();
        activeRuns.delete(startedRunId);
        activeControllers.delete(controller);
      });

    return {
      id: runId,
      command,
      status: "running",
      ...(subprocess.pid ? { pid: subprocess.pid } : {}),
      outputPath: outputPathFor(runId, normalizedOptions.outputPath),
      ...(normalizedOptions.label ? { label: normalizedOptions.label } : {}),
      ...(normalizedOptions.sessionId ? { sessionId: normalizedOptions.sessionId } : {}),
      ...(normalizedOptions.promptPreview ? { promptPreview: normalizedOptions.promptPreview } : {}),
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
    };
  } catch (error) {
    if (!runId) backgroundStartReservations -= 1;
    releaseSession?.();
    throw error;
  }
};

const runQueued = async (command: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> => {
  if (shuttingDown) throw new ClaudeCliError({ code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" });
  if (inFlightCount() >= appConfig.maxQueueSize) {
    throw new ClaudeCliError({ code: "QUEUE_FULL", message: `Too many active or pending Claude requests (${inFlightCount()})` });
  }

  try {
    const result = await claudeQueue.add(
      () => runDirect(command, args, options),
      {
        ...(options.sessionId ? { id: options.sessionId } : {}),
        timeout: appConfig.queueTaskTimeoutMs,
      },
    );
    if (result === undefined) throw new ClaudeCliError({ code: "CLAUDE_QUEUE_ABORTED", message: "Claude queue task was aborted" });
    return result;
  } catch (error) {
    if (error instanceof ClaudeCliError) throw error;
    if (error instanceof TimeoutError) throw new ClaudeCliError({ code: "QUEUE_TIMEOUT", message: "Claude queue task timed out" });
    throw classifyExecaError(error);
  }
};

const runQueuedStreaming = async (command: string, args: readonly string[], options: StreamingProcessRunOptions): Promise<ProcessResult> => {
  if (shuttingDown) throw new ClaudeCliError({ code: "SERVER_SHUTTING_DOWN", message: "Server is shutting down" });
  if (inFlightCount() >= appConfig.maxQueueSize) {
    throw new ClaudeCliError({ code: "QUEUE_FULL", message: `Too many active or pending Claude requests (${inFlightCount()})` });
  }

  try {
    const result = await claudeQueue.add(
      () => runDirectStreaming(command, args, options),
      {
        ...(options.sessionId ? { id: options.sessionId } : {}),
        timeout: appConfig.queueTaskTimeoutMs,
      },
    );
    if (result === undefined) throw new ClaudeCliError({ code: "CLAUDE_QUEUE_ABORTED", message: "Claude queue task was aborted" });
    return result;
  } catch (error) {
    if (error instanceof ClaudeCliError) throw error;
    if (error instanceof TimeoutError) throw new ClaudeCliError({ code: "QUEUE_TIMEOUT", message: "Claude queue task timed out" });
    throw classifyExecaError(error);
  }
};

export const runSupervisedProcess = (
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Effect.Effect<ProcessResult, ClaudeCliError> =>
  Effect.tryPromise({
    try: async () => {
      if (!options.sessionId) return runQueued(command, args, options);
      const lock = withTimeout(getSessionLock(options.sessionId), appConfig.lockWaitTimeoutMs, E_TIMEOUT);
      try {
        return await lock.runExclusive(() => runQueued(command, args, options));
      } catch (error) {
        if (error === E_TIMEOUT) {
          throw new ClaudeCliError({ code: "SESSION_LOCK_TIMEOUT", message: `Timed out waiting for session lock: ${options.sessionId}` });
        }
        throw error;
      }
    },
    catch: (error) => (error instanceof ClaudeCliError ? error : classifyExecaError(error)),
  });

export const runSupervisedStreamingProcess = (
  command: string,
  args: readonly string[],
  options: StreamingProcessRunOptions = {},
): Effect.Effect<ProcessResult, ClaudeCliError> =>
  Effect.tryPromise({
    try: async () => {
      if (!options.sessionId) return runQueuedStreaming(command, args, options);
      const lock = withTimeout(getSessionLock(options.sessionId), appConfig.lockWaitTimeoutMs, E_TIMEOUT);
      try {
        return await lock.runExclusive(() => runQueuedStreaming(command, args, options));
      } catch (error) {
        if (error === E_TIMEOUT) {
          throw new ClaudeCliError({ code: "SESSION_LOCK_TIMEOUT", message: `Timed out waiting for session lock: ${options.sessionId}` });
        }
        throw error;
      }
    },
    catch: (error) => (error instanceof ClaudeCliError ? error : classifyExecaError(error)),
  });

export const shutdownSupervisor = async (): Promise<void> => {
  shuttingDown = true;
  claudeQueue.pause();
  const grace = new Promise<void>((resolve) => {
    setTimeout(resolve, appConfig.shutdownGraceMs).unref();
  });
  await Promise.race([claudeQueue.onPendingZero(), grace]);
  for (const controller of activeControllers) controller.abort();
  claudeQueue.clear();
};
