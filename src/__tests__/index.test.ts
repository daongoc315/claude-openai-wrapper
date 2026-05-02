import { expect, test } from "bun:test";
import { __test__ } from "../index.js";

test("parseArgs maps --version and -v to version command", () => {
  expect(__test__.parseArgs(["--version"]).command).toBe("version");
  expect(__test__.parseArgs(["-v"]).command).toBe("version");
});

test("parseArgs maps --help and -h to help command", () => {
  expect(__test__.parseArgs(["--help"]).command).toBe("help");
  expect(__test__.parseArgs(["-h"]).command).toBe("help");
});
