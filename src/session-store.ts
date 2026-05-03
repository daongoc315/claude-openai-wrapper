import { randomUUID } from "node:crypto";
import { appConfig } from "./config.js";
import { cleanupIdleSessionLocks, cleanupSessionLockIfIdle } from "./process-supervisor.js";
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

export class SessionStore {
  private readonly sessions = new Map<string, MutableSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

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

  constructor(startBackgroundCleanup = true) {
    if (!startBackgroundCleanup) return;
    const intervalMs = Math.max(60_000, Math.min(appConfig.sessionIdleTtlMs, 5 * 60_000));
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
      messages: cappedMessages,
      updatedAt: now,
      turns: session.turns + 1,
    };
    this.sessions.set(id, updated);
    if (!existingSession) this.enforceMaxSessions(id);
    return this.toInfo(updated);
  }

  list(): readonly SessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((session) => this.toInfo(session));
  }
}

export const sessionStore = new SessionStore();
