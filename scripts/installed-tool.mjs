import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Resolve only an already-installed CLI. Never invoke a package manager here:
 * compilation must not install dependencies or rewrite a shared dependency tree. */
export function installedToolEntry(name, root = process.cwd()) {
  if (!["convex", "next"].includes(name)) throw Error("Unsupported build tool");
  const require = createRequire(path.resolve(root, "package.json"));
  let manifest;
  try { manifest = require.resolve(`${name}/package.json`); }
  catch { throw Error(`Build tool ${name} is not installed; run the frozen dependency installation first`); }
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
  if (pkg.name !== name || typeof bin !== "string") throw Error(`Invalid installed ${name} tool manifest`);
  const directory = path.dirname(manifest);
  const entry = path.resolve(directory, bin);
  const relative = path.relative(directory, entry);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !statSync(entry).isFile()) {
    throw Error(`Invalid installed ${name} tool entry`);
  }
  return entry;
}

/** Convex runs --cmd through a shell. Quote the local executable paths rather
 * than relying on package-manager wrappers or an implicitly installed command. */
export function nextBuildCommand(root = process.cwd()) {
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} ${quote(installedToolEntry("next", root))} build`;
}
