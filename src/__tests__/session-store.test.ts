import { expect, test } from "bun:test";
import { SessionStore } from "../session-store.js";

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
