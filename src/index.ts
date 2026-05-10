#!/usr/bin/env node
import { SERVER_NAME, SERVER_VERSION } from "./types.js";

type CliOptions = {
  command?: string;
  port?: string;
  host?: string;
  apiKey?: string;
  background: boolean;
  debug: boolean;
  env: Record<string, string>;
};

const VALUE_FLAGS: Record<string, string> = {
  "--backend": "CLAUDE_OPENAI_BACKEND",
  "--host": "CLAUDE_OPENAI_HOST",
  "--port": "CLAUDE_OPENAI_PORT",
  "--api-key": "CLAUDE_OPENAI_API_KEY",
  "--claude-command": "CLAUDE_OPENAI_CLAUDE_COMMAND",
  "--default-model": "CLAUDE_OPENAI_DEFAULT_MODEL",
  "--models": "CLAUDE_MODELS_OVERRIDE",
  "--cors-origins": "CORS_ORIGINS",
  "--allowed-permission-modes": "CLAUDE_OPENAI_ALLOWED_PERMISSION_MODES",
  "--allowed-working-directory-prefixes": "CLAUDE_OPENAI_ALLOWED_WORKING_DIR_PREFIXES",
  "--max-request-bytes": "CLAUDE_OPENAI_MAX_REQUEST_BYTES",
  "--max-concurrency": "CLAUDE_OPENAI_MAX_CONCURRENCY",
  "--queue-interval-cap": "CLAUDE_OPENAI_QUEUE_INTERVAL_CAP",
  "--queue-interval-ms": "CLAUDE_OPENAI_QUEUE_INTERVAL_MS",
  "--queue-task-timeout-ms": "CLAUDE_OPENAI_QUEUE_TASK_TIMEOUT_MS",
  "--max-queue-size": "CLAUDE_OPENAI_MAX_QUEUE_SIZE",
  "--process-timeout-ms": "CLAUDE_OPENAI_PROCESS_TIMEOUT_MS",
  "--kill-grace-period-ms": "CLAUDE_OPENAI_KILL_GRACE_PERIOD_MS",
  "--max-prompt-bytes": "CLAUDE_OPENAI_MAX_PROMPT_BYTES",
  "--max-output-bytes": "CLAUDE_OPENAI_MAX_OUTPUT_BYTES",
  "--max-returned-error-bytes": "CLAUDE_OPENAI_MAX_RETURNED_ERROR_BYTES",
  "--session-ttl-ms": "CLAUDE_OPENAI_SESSION_TTL_MS",
  "--session-lock-timeout-ms": "CLAUDE_OPENAI_SESSION_LOCK_TIMEOUT_MS",
  "--shutdown-grace-ms": "CLAUDE_OPENAI_SHUTDOWN_GRACE_MS",
  "--output-dir": "CLAUDE_OPENAI_OUTPUT_DIR",
  "--log-level": "CLAUDE_OPENAI_LOG_LEVEL",
  "--log-file": "CLAUDE_OPENAI_LOG_FILE",
  "--trace-file": "CLAUDE_OPENAI_TRACE_FILE",
  "--claude-config-dir": "CLAUDE_OPENAI_CLAUDE_CONFIG_DIR",
  "--agent-sdk-client-app": "CLAUDE_OPENAI_AGENT_SDK_CLIENT_APP",
};

const BOOLEAN_FLAGS: Record<string, string> = {
  "--log": "CLAUDE_OPENAI_LOG",
  "--trace": "CLAUDE_OPENAI_TRACE",
  "--allow-bypass-permissions": "CLAUDE_OPENAI_ALLOW_BYPASS_PERMISSIONS",
  "--allow-explicit-tools": "CLAUDE_OPENAI_ALLOW_EXPLICIT_TOOLS",
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { background: false, debug: false, env: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw) continue;
    const [arg, inlineValue] = raw.includes("=") ? (raw.split(/=(.*)/s, 2) as [string, string]) : [raw, undefined];
    if (!arg) continue;
    if (!arg.startsWith("-") && !options.command) {
      options.command = arg;
      continue;
    }
    if (arg === "--background" || arg === "--bg" || arg === "background") options.background = true;
    else if (arg === "--debug" || arg === "-d") {
      options.debug = true;
      options.env.CLAUDE_OPENAI_DEBUG = "true";
      options.env.CLAUDE_OPENAI_LOG_LEVEL = "debug";
    }
    else if (arg === "--version" || arg === "-v") options.command = "version";
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--stop") options.command = "stop";
    else if (arg === "--status") options.command = "status";
    else if (arg === "-p" || arg === "-k") {
      const value = inlineValue ?? argv[++i];
      if (!value) continue;
      const envName = arg === "-p" ? "CLAUDE_OPENAI_PORT" : "CLAUDE_OPENAI_API_KEY";
      options.env[envName] = value;
      if (arg === "-p") options.port = value;
      else options.apiKey = value;
    } else if (VALUE_FLAGS[arg]) {
      const value = inlineValue ?? argv[++i];
      if (!value) continue;
      options.env[VALUE_FLAGS[arg]] = value;
      if (arg === "--port") options.port = value;
      if (arg === "--host") options.host = value;
      if (arg === "--api-key") options.apiKey = value;
    } else if (BOOLEAN_FLAGS[arg]) {
      options.env[BOOLEAN_FLAGS[arg]] = inlineValue ?? "true";
      if (arg === "--trace") options.env.CLAUDE_OPENAI_LOG_LEVEL = "trace";
    }
  }
  return options;
};

const applyServerEnv = (options: CliOptions): void => {
  Object.assign(process.env, options.env);
};

const startForeground = async (options: CliOptions): Promise<void> => {
  applyServerEnv(options);
  const { startHttpServer } = await import("./api/http-server.js");
  await startHttpServer();
};

const printHelp = (): void => {
  console.log(`${SERVER_NAME} ${SERVER_VERSION}\n\nUsage:\n  claude-openai start [options]                    Start as background daemon\n  claude-openai debug [options]                    Run foreground with debug logs\n  claude-openai stop                               Stop background daemon\n  claude-openai restart [options]                  Restart background daemon\n  claude-openai status                             Show daemon status + health\n  claude-openai logs                               Tail daemon log file\n  claude-openai [options]                          (default) Run foreground server\n  claude-openai runs | tail <runId> | cancel <runId>\n\nCommon options:\n  --host 127.0.0.1\n  --port 8000\n  --api-key dev-local-key\n  --backend sdk|cli\n  --default-model sonnet\n  --claude-command claude\n  --allowed-working-directory-prefixes /repo,/tmp\n  --max-concurrency 4\n  --process-timeout-ms 300000\n  --log true --log-level debug --log-file claude-openai.log.ndjson\n  --trace true --trace-file claude-openai.trace.ndjson\n  --debug\n\nEnvironment equivalents use CLAUDE_OPENAI_* names.`);
};

export const runCli = async (argv: readonly string[]): Promise<number> => {
  const options = parseArgs(argv);
  applyServerEnv(options);
  const arg = options.command;

  if (arg === "version") {
    console.log(`${SERVER_NAME} ${SERVER_VERSION}`);
    return 0;
  }

  if (arg === "help") {
    printHelp();
    return 0;
  }

  if (arg === "serve") {
    await startForeground(options);
    return 0;
  }

  if (arg === "start" || arg === undefined) {
    const { startDaemon } = await import("./daemon.js");
    try {
      const pid = startDaemon(options);
      const port = options.port || process.env.CLAUDE_OPENAI_PORT || "8765";
      console.log(`Started ${SERVER_NAME} daemon pid=${pid}`);
      console.log(`API: http://127.0.0.1:${port}/v1/chat/completions`);
      console.log(`Logs: claude-openai logs`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (arg === "debug") {
    process.env.CLAUDE_OPENAI_DEBUG = "true";
    process.env.CLAUDE_OPENAI_LOG = "true";
    process.env.CLAUDE_OPENAI_LOG_LEVEL = "debug";
    await startForeground(options);
    return 0;
  }

  if (arg === "stop") {
    const { stopDaemon } = await import("./daemon.js");
    const stopped = await stopDaemon();
    console.log(stopped ? "Stopped daemon" : "No running daemon");
    return stopped ? 0 : 1;
  }

  if (arg === "restart") {
    const { startDaemon, stopDaemon } = await import("./daemon.js");
    await stopDaemon();
    try {
      const pid = startDaemon(options);
      console.log(`Restarted ${SERVER_NAME} daemon pid=${pid}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (arg === "logs") {
    const { LOG_FILE } = await import("./daemon.js");
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    if (!existsSync(LOG_FILE)) {
      console.error(`No log file found at ${LOG_FILE}`);
      return 1;
    }
    const tail = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
    return await new Promise((resolve) => tail.on("exit", (code) => resolve(code ?? 0)));
  }

  if (arg === "status") {
    const { getDaemonStatus } = await import("./daemon.js");
    const status = await getDaemonStatus();
    console.log(`running=${status.running} pid=${status.pid ?? "-"} port=${status.port ?? "-"} health=${status.health}`);
    return status.running ? 0 : 1;
  }

  if (arg === "runs") {
    const { listRegistryRuns } = await import("./run-registry.js");
    const runs = await listRegistryRuns();
    if (!runs.length) console.log("No known Claude runs");
    else {
      for (const run of runs) {
        const elapsed = Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000);
        console.log(`${run.id} status=${run.status} elapsed=${elapsed}s pid=${run.claudePid ?? "?"} output=${run.outputPath}`);
        if (run.promptPreview) console.log(`  prompt=${run.promptPreview}`);
      }
    }
    return 0;
  }

  if (arg === "tail") {
    const { isValidRunId, readRunOutput } = await import("./run-registry.js");
    const runId = argv[1];
    if (!isValidRunId(runId)) {
      console.error("Missing or invalid runId");
      return 1;
    }
    const output = await readRunOutput(runId);
    process.stdout.write(output || "No output yet\n");
    return 0;
  }

  if (arg === "cancel") {
    const { cancelRegistryRun, isValidRunId } = await import("./run-registry.js");
    const runId = argv[1];
    if (!isValidRunId(runId)) {
      console.error("Missing or invalid runId");
      return 1;
    }
    const canceled = await cancelRegistryRun(runId);
    console.log(canceled ? `Canceled ${runId}` : `Could not cancel ${runId}`);
    return canceled ? 0 : 1;
  }

  await startForeground(options);
  return 0;
};

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

export const __test__ = { parseArgs };
