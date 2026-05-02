import { expect, test } from "bun:test";
import { isValidRunId, outputPathFor } from "../run-registry.js";

test("validates registry run ids", () => {
  expect(isValidRunId("abc-123_DEF.ghi:jkl")).toBe(true);
  expect(isValidRunId("../../etc/passwd")).toBe(false);
});

test("rejects path traversal in output paths", () => {
  expect(() => outputPathFor("../../etc/passwd")).toThrow("Invalid run id");
});
