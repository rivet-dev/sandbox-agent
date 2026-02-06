import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const dirPath = process.argv[2] || "/";
  const entries = await readdir(dirPath);
  const results = await Promise.all(
    entries.map(async (name) => {
      const s = await stat(join(dirPath, name));
      return `${s.isDirectory() ? "d" : "-"} ${name}`;
    }),
  );
  console.log(results.join("\n"));
}

main();
