#!/usr/bin/env node
import { SERVER_NAME, SERVER_VERSION } from "./types.js";

type CliOptions = {
  command?: string;
  port?: string;
  host?: string;
  apiKey?: string;
  background: boolean;
  debug: boolean;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { background: false, debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("-") && !options.command) {
      options.command = arg;
      continue;
    }
    if (arg === "--background" || arg === "--bg" || arg === "background") options.background = true;
    else if (arg === "--debug" || arg === "-d") options.debug = true;
    else if (arg === "--version" || arg === "-v") options.command = "version";
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--stop") options.command = "stop";
    else if (arg === "--status") options.command = "status";
    else if (arg === "--port" || arg === "-p") {
      const value = argv[++i];
      if (value) options.port = value;
    } else if (arg === "--host") {
      const value = argv[++i];
      if (value) options.host = value;
    } else if (arg === "--api-key" || arg === "-k") {
      const value = argv[++i];
      if (value) options.apiKey = value;
    }
  }
  return options;
};

const applyServerEnv = (options: Pick<CliOptions, "apiKey" | "host" | "port">): void => {
  if (options.host) process.env.CLAUDE_WRAPPER_HOST = options.host;
  if (options.port) process.env.CLAUDE_WRAPPER_PORT = options.port;
  if (options.apiKey) process.env.CLAUDE_WRAPPER_API_KEY = options.apiKey;
};

const startForeground = async (options: CliOptions): Promise<void> => {
  applyServerEnv(options);
  const { startHttpServer } = await import("./api/http-server.js");
  await startHttpServer();
};

const printHelp = (): void => {
  console.log(`${SERVER_NAME} ${SERVER_VERSION}\n\nUsage:\n  claude-openai-wrapper [--port 8000] [--api-key key]       Start foreground server\n  claude-openai-wrapper --background                       Start background daemon\n  claude-openai-wrapper --debug                            Start foreground server with debug intent\n  claude-openai-wrapper status | --status                  Show daemon status\n  claude-openai-wrapper stop | --stop                      Stop daemon\n  claude-openai-wrapper runs                               List known Claude runs\n  claude-openai-wrapper tail <runId>                       Print captured run output\n  claude-openai-wrapper cancel <runId>                     Cancel an active Claude run\n\nEnvironment:\n  CLAUDE_WRAPPER_HOST=127.0.0.1\n  CLAUDE_WRAPPER_PORT=8000\n  CLAUDE_WRAPPER_API_KEY=optional-local-token\n  CLAUDE_WRAPPER_BACKEND=sdk|cli\n  CLAUDE_COMMAND=claude`);
};

export const runCli = async (argv: readonly string[]): Promise<number> => {
  const options = parseArgs(argv);
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

  if (arg === "stop") {
    const { stopDaemon } = await import("./daemon.js");
    const stopped = await stopDaemon();
    console.log(stopped ? "Stopped daemon" : "No running daemon");
    return stopped ? 0 : 1;
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

  if (options.background) {
    const { startDaemon } = await import("./daemon.js");
    try {
      const pid = startDaemon(options);
      const port = options.port || process.env.CLAUDE_WRAPPER_PORT || "8000";
      console.log(`Started ${SERVER_NAME} daemon pid=${pid}`);
      console.log(`API: http://127.0.0.1:${port}/v1/chat/completions`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  await startForeground(options);
  return 0;
};

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

export const __test__ = { parseArgs };
