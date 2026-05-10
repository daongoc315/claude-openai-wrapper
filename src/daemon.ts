import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PID_FILE = join(tmpdir(), "claude-openai.pid");
const PORT_FILE = join(tmpdir(), "claude-openai.port");
export const LOG_FILE = join(tmpdir(), "claude-openai.log");
const SHUTDOWN_TIMEOUT_MS = 5_000;
const CHECK_INTERVAL_MS = 100;

export interface DaemonStartOptions {
  readonly host?: string;
  readonly port?: string;
  readonly apiKey?: string;
  readonly debug?: boolean;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly port: string | null;
  readonly health: "healthy" | "unhealthy" | "unknown";
}

export const readPid = (): number | null => {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

export const writePid = (pid: number): void => {
  writeFileSync(PID_FILE, String(pid), "utf8");
};

export const readDaemonPort = (): string | null => {
  if (!existsSync(PORT_FILE)) return null;
  const port = readFileSync(PORT_FILE, "utf8").trim();
  return port || null;
};

export const writeDaemonPort = (port: string): void => {
  writeFileSync(PORT_FILE, port, "utf8");
};

export const cleanupDaemonFiles = (): void => {
  for (const file of [PID_FILE, PORT_FILE]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // Best-effort cleanup.
    }
  }
};

export const isProcessRunning = (pid: number | null = readPid()): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const validateAndCleanupDaemon = (): boolean => {
  const pid = readPid();
  const running = isProcessRunning(pid);
  if (pid && !running) cleanupDaemonFiles();
  return running;
};

const waitForExit = async (pid: number, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
  return !isProcessRunning(pid);
};

export const startDaemon = (options: DaemonStartOptions = {}): number => {
  if (validateAndCleanupDaemon()) {
    const pid = readPid();
    throw new Error(`Daemon already running${pid ? ` with PID ${pid}` : ""}`);
  }

  const script = process.argv[1];
  if (!script) throw new Error("Unable to determine current executable script path");

  const env = { ...process.env };
  if (options.host) env.CLAUDE_OPENAI_HOST = options.host;
  if (options.port) env.CLAUDE_OPENAI_PORT = options.port;
  if (options.apiKey) env.CLAUDE_OPENAI_API_KEY = options.apiKey;
  if (options.debug) env.DEBUG = "1";

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [script, "serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });

  if (!child.pid) throw new Error("Failed to start daemon process");
  writePid(child.pid);
  writeDaemonPort(options.port || env.CLAUDE_OPENAI_PORT || "8765");
  child.unref();
  return child.pid;
};

export const stopDaemon = async (): Promise<boolean> => {
  const pid = readPid();
  if (!pid) return false;
  if (!isProcessRunning(pid)) {
    cleanupDaemonFiles();
    return false;
  }

  process.kill(pid, "SIGTERM");
  const exited = await waitForExit(pid);
  if (!exited && isProcessRunning(pid)) process.kill(pid, "SIGKILL");
  cleanupDaemonFiles();
  return true;
};

export const getDaemonStatus = async (): Promise<DaemonStatus> => {
  const running = validateAndCleanupDaemon();
  const pid = running ? readPid() : null;
  const port = running ? readDaemonPort() : null;
  let health: DaemonStatus["health"] = "unknown";

  if (running && port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      health = response.ok ? "healthy" : "unhealthy";
    } catch {
      health = "unknown";
    }
  }

  return { running, pid, port, health };
};

export const __test__ = {
  isProcessRunning,
  readDaemonPort,
  readPid,
  validateAndCleanupDaemon,
};
