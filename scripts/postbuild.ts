import { chmod, readFile, writeFile } from "node:fs/promises";

const entry = "dist/index.js";
const shebang = "#!/usr/bin/env node";
const contents = await readFile(entry, "utf8");

if (!contents.startsWith(shebang)) {
  await writeFile(entry, `${shebang}\n${contents}`, "utf8");
}

await chmod(entry, 0o755);
