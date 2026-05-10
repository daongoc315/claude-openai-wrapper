import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appConfig } from "./config.js";
import { cleanupIdleSessionLocks, cleanupSessionLockIfIdle } from "./process-supervisor.js";
import { traceEvent } from "./trace.js";
import type { SessionInfo, SessionMessage } from "./types.js";

interface MutableSession {
  id: string;
  claudeSessionId?: string;
  createdAt: Date;
  updatedAt: Date;
  turns: number;
  messages: SessionMessage[];
}

type RecordTurnInput = {
  readonly prompt?: string;
  readonly response?: string;
  readonly claudeSessionId?: string;
};

type PersistedSession = {
  readonly claudeSessionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly turns?: number;
};

type PersistedSessionMap = Record<string, PersistedSession>;

// Treats common env var "disabled" strings as falsy, case-insensitive, trimming whitespace.
// e.g. "False", " NO ", "OFF" all return true.
const falsy = (value: string | undefined): boolean => {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
};

const DEFAULT_SESSION_MAP_DIR = ".claude-openai"; // Relative to home directory
const DEFAULT_SESSION_MAP_FILE = "session-map.json";

// 0o600 = owner read/write only. Session map may contain sensitive session IDs.
const SESSION_MAP_FILE_MODE = 0o600;

// Cleanup interval is clamped between 1 minute (minimum) and 5 minutes (maximum),
// bounded by the session idle TTL so we don't clean up too rarely.
const CLEANUP_INTERVAL_MIN_MS = 60_000; // 1 minute minimum
const CLEANUP_INTERVAL_MAX_MS = 5 * 60_000; // 5 minute maximum

export const defaultSessionMapPath = (): string | undefined => {
  if (falsy(process.env.CLAUDE_OPENAI_SESSION_MAP_FILE)) return undefined;
  return resolve(process.env.CLAUDE_OPENAI_SESSION_MAP_FILE || join(homedir(), DEFAULT_SESSION_MAP_DIR, DEFAULT_SESSION_MAP_FILE));
};

export class SessionStore {
  private readonly sessions = new Map<string, MutableSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private readonly persistPath: string | undefined;

  private truncateContent(content: string): string {
    if (content.length <= appConfig.maxSessionContentChars) return content;
    return `${content.slice(0, appConfig.maxSessionContentChars)}\n… truncated (${content.length} chars total)`;
  }

  private enforceMaxSessions(excludeId?: string): void {
    if (this.sessions.size <= appConfig.maxSessions) return;
    const evictionCandidates = [...this.sessions.values()]
      .filter((session) => session.id !== excludeId)
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());

    for (const session of evictionCandidates) {
      if (this.sessions.size <= appConfig.maxSessions) break;
      this.sessions.delete(session.id);
      cleanupSessionLockIfIdle(session.id);
    }
  }

  private toInfo(session: MutableSession): SessionInfo {
    return { ...session, messages: session.messages.map((message) => ({ ...message })) };
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

      for (const [id, persisted] of Object.entries(parsed as PersistedSessionMap)) {
        if (!persisted?.claudeSessionId) continue;
        const parsedCreatedAt = persisted.createdAt ? new Date(persisted.createdAt) : new Date();
        const parsedUpdatedAt = persisted.updatedAt ? new Date(persisted.updatedAt) : parsedCreatedAt;
        const createdAtValid = !Number.isNaN(parsedCreatedAt.getTime());
        const updatedAtValid = !Number.isNaN(parsedUpdatedAt.getTime());
        if (!createdAtValid || !updatedAtValid) {
          traceEvent("session_store.invalid_date_repaired", { id, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt }, "debug");
        }
        this.sessions.set(id, {
          id,
          claudeSessionId: persisted.claudeSessionId,
          createdAt: createdAtValid ? parsedCreatedAt : new Date(),
          updatedAt: updatedAtValid ? parsedUpdatedAt : new Date(),
          turns: typeof persisted.turns === "number" && persisted.turns >= 0 ? persisted.turns : 0,
          messages: [],
        });
      }
      this.enforceMaxSessions();
      traceEvent("session_store.loaded", { path: this.persistPath, sessions: this.sessions.size }, "debug");
    } catch (error) {
      traceEvent("session_store.load_failed", { path: this.persistPath, error: error instanceof Error ? error.message : String(error) }, "debug");
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    const data: PersistedSessionMap = {};
    for (const session of this.sessions.values()) {
      if (!session.claudeSessionId) continue;
      data[session.id] = {
        claudeSessionId: session.claudeSessionId,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        turns: session.turns,
      };
    }

    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Atomic write: write to a PID-scoped temp file then rename to avoid partial reads.
      // Note: stale .tmp files are harmless but can be cleaned up manually if a process crashes.
      const tempPath = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: SESSION_MAP_FILE_MODE });
      renameSync(tempPath, this.persistPath);
      traceEvent("session_store.persisted", { path: this.persistPath, sessions: Object.keys(data).length }, "trace");
    } catch (error) {
      traceEvent("session_store.persist_failed", { path: this.persistPath, error: error instanceof Error ? error.message : String(error) }, "debug");
    }
  }

  constructor(startBackgroundCleanup = true, persistPath?: string | false) {
    this.persistPath = persistPath === false ? undefined : persistPath;
    this.loadPersisted();
    if (!startBackgroundCleanup) return;
    const intervalMs = Math.max(CLEANUP_INTERVAL_MIN_MS, Math.min(appConfig.sessionIdleTtlMs, CLEANUP_INTERVAL_MAX_MS));
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle();
    }, intervalMs);
    this.cleanupTimer.unref?.();
  }

  stopBackgroundCleanup(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  getOrCreate(id?: string): SessionInfo {
    if (id) {
      const existing = this.sessions.get(id);
      if (existing) return this.toInfo(existing);
    }

    const session: MutableSession = {
      id: id ?? randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      turns: 0,
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.enforceMaxSessions(session.id);
    return this.toInfo(session);
  }

  get(id: string): SessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.toInfo(session) : undefined;
  }

  reset(id: string): void {
    this.sessions.delete(id);
    cleanupSessionLockIfIdle(id);
    this.persist();
  }

  cleanupIdle(now = Date.now(), ttlMs = appConfig.sessionIdleTtlMs): number {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt.getTime() > ttlMs) {
        this.sessions.delete(id);
        cleanupSessionLockIfIdle(id);
        deleted += 1;
      }
    }
    cleanupIdleSessionLocks(new Set(this.sessions.keys()));
    if (deleted > 0) this.persist();
    return deleted;
  }

  recordTurn(id: string, input: string | RecordTurnInput = {}): SessionInfo {
    const data = typeof input === "string" ? { claudeSessionId: input } : input;
    const existingSession = this.sessions.get(id);
    const session = existingSession ?? {
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
      turns: 0,
      messages: [],
    };

    const now = new Date();
    const messages = [...session.messages];
    if (data.prompt) messages.push({ role: "user", content: this.truncateContent(data.prompt), createdAt: now });
    if (data.response) {
      messages.push({
        role: "assistant",
        content: this.truncateContent(data.response),
        createdAt: now,
        ...(data.claudeSessionId ? { claudeSessionId: data.claudeSessionId } : {}),
      });
    }

    const cappedMessages = messages.slice(-appConfig.maxSessionMessages);

    const updated: MutableSession = {
      ...session,
      ...(data.claudeSessionId ? { claudeSessionId: data.claudeSessionId } : {}),
      messages: cappedMessages, // Keep only the N most recent messages
      updatedAt: now,
      turns: session.turns + 1,
    };
    this.sessions.set(id, updated);
    if (!existingSession) this.enforceMaxSessions(id);
    this.persist();
    return this.toInfo(updated);
  }

  list(): readonly SessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((session) => this.toInfo(session));
  }
}

export const sessionStore = new SessionStore(true, defaultSessionMapPath());
