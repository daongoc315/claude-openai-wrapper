import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const runIdPattern = /^[A-Za-z0-9._:-]+$/;

export const isValidRunId = (id: string | undefined): id is string => Boolean(id && runIdPattern.test(id));

const assertValidRunId = (id: string): void => {
  if (!isValidRunId(id)) throw new Error("Invalid run id");
};

export interface RegistryRun {
  readonly id: string;
  readonly serverPid: number;
  readonly claudePid?: number;
  readonly workspace?: string;
  readonly sessionId?: string;
  readonly label?: string;
  readonly promptPreview?: string;
  readonly command: string;
  readonly outputPath: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly status: "running" | "completed" | "failed" | "canceled";
}

const registryDir = join(homedir(), ".claude-openai", "runs");
const outputDir = process.env.CLAUDE_OPENAI_OUTPUT_DIR || join(homedir(), ".claude-openai", "output");

const fileFor = (id: string): string => {
  assertValidRunId(id);
  return join(registryDir, `${id}.json`);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const writeRun = async (run: RegistryRun): Promise<void> => {
  await mkdir(registryDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(fileFor(run.id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
};

export const outputPathFor = (id: string, outputPath?: string): string => {
  assertValidRunId(id);
  if (outputPath) return resolve(outputPath);
  return join(outputDir, `${id}.jsonl`);
};

export const appendRunOutput = async (id: string, stream: "stdout" | "stderr", line: string, outputPath?: string): Promise<void> => {
  const path = outputPathFor(id, outputPath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), stream, line })}\n`, "utf8");
};

export const appendRunEvent = async (id: string, event: string, data: Record<string, unknown> = {}, outputPath?: string): Promise<void> => {
  const path = outputPathFor(id, outputPath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`, "utf8");
};

export const readRunOutput = async (id: string): Promise<string> => {
  try {
    return await readFile(outputPathFor(id), "utf8");
  } catch {
    return "";
  }
};

export const updateRun = async (id: string, patch: Partial<RegistryRun>): Promise<void> => {
  const existing = await readRun(id);
  if (!existing) return;
  await writeRun({ ...existing, ...patch, updatedAt: new Date().toISOString() });
};

export const removeRun = async (id: string): Promise<void> => {
  await rm(fileFor(id), { force: true });
};

export const readRun = async (id: string): Promise<RegistryRun | undefined> => {
  try {
    return JSON.parse(await readFile(fileFor(id), "utf8")) as RegistryRun;
  } catch {
    return undefined;
  }
};

export const listRegistryRuns = async (): Promise<readonly RegistryRun[]> => {
  await mkdir(registryDir, { recursive: true });
  const files = await readdir(registryDir);
  const runs: RegistryRun[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    const run = await readRun(id);
    if (!run) continue;
    if (run.status === "running" && !isAlive(run.serverPid) && (!run.claudePid || !isAlive(run.claudePid))) {
      await removeRun(run.id);
      continue;
    }
    runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

export const cancelRegistryRun = async (id: string): Promise<boolean> => {
  const run = await readRun(id);
  if (!run?.claudePid) return false;
  try {
    process.kill(run.claudePid, "SIGTERM");
    await updateRun(id, { status: "canceled" });
    return true;
  } catch {
    return false;
  }
};
