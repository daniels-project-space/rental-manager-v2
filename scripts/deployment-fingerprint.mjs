import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Hash complete, ordered file inputs without loading the TypeScript compiler. */
export function signature(files, root = process.cwd()) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const bytes = fs.readFileSync(path.join(root, file));
    hash.update(JSON.stringify([file, bytes.length])); hash.update(bytes);
  }
  return hash.digest("hex");
}
