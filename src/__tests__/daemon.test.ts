import { expect, test } from "bun:test";
import { __test__ } from "../daemon.js";

test("daemon process check handles missing pid", () => {
  expect(__test__.isProcessRunning(null)).toBe(false);
});
