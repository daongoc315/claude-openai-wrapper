import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../core/agent-sdk-client.js";

test("normalizePermissionMode sanitizes unsupported modes", () => {
  expect(__test__.normalizePermissionMode(undefined)).toBe("default");
  expect(__test__.normalizePermissionMode("default")).toBe("default");
  expect(__test__.normalizePermissionMode("auto")).toBe("acceptEdits");
  expect(__test__.normalizePermissionMode("plan")).toBe("plan");
  expect(__test__.normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
  expect(__test__.normalizePermissionMode("bypassPermissions" as never)).toBe("default");
});

test("assertSdkSafety rejects bypassPermissions by default", async () => {
  delete process.env.CLAUDE_WRAPPER_ALLOW_BYPASS_PERMISSIONS;
  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      permissionMode: "bypassPermissions" as never,
    }),
  ).rejects.toThrow("bypassPermissions is not allowed");
});

test("assertSdkSafety rejects explicit tools unless opt-in", async () => {
  delete process.env.CLAUDE_WRAPPER_ALLOW_EXPLICIT_TOOLS;
  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      tools: ["Bash"],
    }),
  ).rejects.toThrow("explicit tools are disabled");
});

test("assertSdkSafety validates addDirs and workingDirectory prefixes", async () => {
  const safeDir = join(process.cwd(), ".tmp-agent-sdk-safe");
  await mkdir(safeDir, { recursive: true });
  const outsideDir = join(tmpdir(), "agent-sdk-outside");
  await mkdir(outsideDir, { recursive: true });

  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      workingDirectory: safeDir,
      addDirs: [safeDir],
    }),
  ).resolves.toBeDefined();

  await expect(
    __test__.assertSdkSafety({
      prompt: "hi",
      workingDirectory: outsideDir,
    }),
  ).rejects.toThrow("outside allowed prefixes");
});
