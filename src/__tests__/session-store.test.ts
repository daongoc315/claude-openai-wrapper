import { expect, test } from "bun:test";
import { appConfig } from "../config.js";
import { SessionStore } from "../session-store.js";

const mutableConfig = appConfig as { maxSessionContentChars: number; maxSessionMessages: number; maxSessions: number };

test("creates and records sessions", () => {
  const store = new SessionStore();
  const session = store.getOrCreate("abc");

  expect(session.id).toBe("abc");
  expect(session.turns).toBe(0);

  const updated = store.recordTurn("abc", "claude-123");
  expect(updated.turns).toBe(1);
  expect(updated.claudeSessionId).toBe("claude-123");
  expect(store.list()).toHaveLength(1);
});

test("records prompt and response history", () => {
  const store = new SessionStore();
  const updated = store.recordTurn("abc", { prompt: "hi", response: "hello", claudeSessionId: "claude-123" });

  expect(updated.messages).toHaveLength(2);
  expect(updated.messages[0]?.role).toBe("user");
  expect(updated.messages[0]?.content).toBe("hi");
  expect(updated.messages[1]?.role).toBe("assistant");
  expect(updated.messages[1]?.content).toBe("hello");
});

test("reset removes sessions", () => {
  const store = new SessionStore();
  store.getOrCreate("abc");
  store.reset("abc");

  expect(store.get("abc")).toBeUndefined();
});

test("cleanupIdle removes expired sessions", () => {
  const store = new SessionStore();
  store.getOrCreate("old");
  const deleted = store.cleanupIdle(Date.now() + 10_000, 1);

  expect(deleted).toBe(1);
  expect(store.get("old")).toBeUndefined();
});

test("truncates long prompt and response content", () => {
  const originalMaxChars = mutableConfig.maxSessionContentChars;
  mutableConfig.maxSessionContentChars = 10;
  try {
    const store = new SessionStore(false);
    const updated = store.recordTurn("abc", {
      prompt: "123456789012345",
      response: "abcdefghijklmno",
    });

    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[0]?.content).toBe("1234567890\n… truncated (15 chars total)");
    expect(updated.messages[1]?.content).toBe("abcdefghij\n… truncated (15 chars total)");
  } finally {
    mutableConfig.maxSessionContentChars = originalMaxChars;
  }
});

test("caps stored messages to maxSessionMessages", () => {
  const originalMaxMessages = mutableConfig.maxSessionMessages;
  mutableConfig.maxSessionMessages = 3;
  try {
    const store = new SessionStore(false);
    store.recordTurn("abc", { prompt: "p1", response: "r1" });
    store.recordTurn("abc", { prompt: "p2", response: "r2" });
    const updated = store.recordTurn("abc", { prompt: "p3", response: "r3" });

    expect(updated.messages).toHaveLength(3);
    expect(updated.messages.map((message) => message.content)).toEqual(["r2", "p3", "r3"]);
  } finally {
    mutableConfig.maxSessionMessages = originalMaxMessages;
  }
});

test("maxSessions evicts oldest session and keeps newly created session", () => {
  const originalMaxSessions = mutableConfig.maxSessions;
  mutableConfig.maxSessions = 2;
  try {
    const store = new SessionStore(false);
    store.getOrCreate("oldest");
    store.getOrCreate("middle");
    const newest = store.getOrCreate("newest");

    expect(newest.id).toBe("newest");
    expect(store.get("newest")).toBeDefined();
    expect(store.get("oldest")).toBeUndefined();
    expect(store.get("middle")).toBeDefined();
    expect(store.list()).toHaveLength(2);
  } finally {
    mutableConfig.maxSessions = originalMaxSessions;
  }
});
