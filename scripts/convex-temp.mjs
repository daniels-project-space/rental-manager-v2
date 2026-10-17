import fs from "node:fs";
import path from "node:path";

/** A single owned compiler workspace on the project filesystem. Cleanup never
 * touches an explicitly configured/shared CONVEX_TMPDIR or another build. */
export async function withConvexTemp(work, { root = process.cwd(), env = process.env } = {}) {
  if (env.CONVEX_TMPDIR) return await work(env);
  const directory = fs.mkdtempSync(path.join(root, ".convex-tmp-"));
  try { return await work({ ...env, CONVEX_TMPDIR: directory }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
