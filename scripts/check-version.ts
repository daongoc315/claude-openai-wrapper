import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
const typesSource = await readFile("src/types.ts", "utf8");

const packageVersion = packageJson.version;
const match = typesSource.match(/export const SERVER_VERSION = "([^"]+)";/);
const sourceVersion = match?.[1];

if (typeof packageVersion !== "string" || !sourceVersion) {
  console.error("Unable to read package.json version or src/types.ts SERVER_VERSION.");
  process.exit(1);
}

if (packageVersion !== sourceVersion) {
  console.error(
    `Version mismatch: package.json has ${packageVersion}, but src/types.ts has ${sourceVersion}. Update both before release.`,
  );
  process.exit(1);
}
