import { randomUUID } from "node:crypto";
import { appConfig } from "./config.js";
import { cleanupIdleSessionLocks, releaseSessionLock } from "./process-supervisor.js";
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
    return this.toInfo(session);
  }

  get(id: string): SessionInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.toInfo(session) : undefined;
  }

  reset(id: string): void {
    this.sessions.delete(id);
    releaseSessionLock(id);
  }

  cleanupIdle(now = Date.now(), ttlMs = appConfig.sessionIdleTtlMs): number {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt.getTime() > ttlMs) {
        this.sessions.delete(id);
        releaseSessionLock(id);
        deleted += 1;
      }
    }
    cleanupIdleSessionLocks(new Set(this.sessions.keys()));
    return deleted;
  }

  recordTurn(id: string, input: string | RecordTurnInput = {}): SessionInfo {
    const data = typeof input === "string" ? { claudeSessionId: input } : input;
    const session = this.sessions.get(id) ?? {
      id,
      createdAt: new Date(),
      updatedAt: new Date(),
      turns: 0,
      messages: [],
    };

    const now = new Date();
    const messages = [...session.messages];
    if (data.prompt) messages.push({ role: "user", content: data.prompt, createdAt: now });
    if (data.response) {
      messages.push({
        role: "assistant",
        content: data.response,
        createdAt: now,
        ...(data.claudeSessionId ? { claudeSessionId: data.claudeSessionId } : {}),
      });
    }

    const updated: MutableSession = {
      ...session,
      ...(data.claudeSessionId ? { claudeSessionId: data.claudeSessionId } : {}),
      messages,
      updatedAt: now,
      turns: session.turns + 1,
    };
    this.sessions.set(id, updated);
    return this.toInfo(updated);
  }

  list(): readonly SessionInfo[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((session) => this.toInfo(session));
  }
}

export const sessionStore = new SessionStore();
