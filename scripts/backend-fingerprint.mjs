import fs from "node:fs";
import path from "node:path";
import { signature } from "./deployment-fingerprint.mjs";
import { execFileSync } from "node:child_process";

export const generatedFile = "convex/lib/deployment_implementation.ts";
export function backendFingerprint(root = process.cwd()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "deployment-inputs.json"), "utf8"));
  if (manifest.version !== 1 || manifest.backend.uncertain.length) throw Error("Backend dependency boundary is unavailable or uncertain");
  const files = [...manifest.backend.files, ...manifest.globals, "scripts/backend-fingerprint.mjs", "scripts/backend-publisher.mjs"]
    .filter(file => file !== generatedFile && !file.endsWith(".d.ts"));
  return signature(files, root);
}
export function writeBackendFingerprint(root = process.cwd()) {
  const fingerprint = backendFingerprint(root);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("Backend source commit is invalid");
  fs.writeFileSync(path.join(root, generatedFile), `// Written in the isolated build workspace before publishing, never at runtime.\nexport const BACKEND_SOURCE_FINGERPRINT: string = ${JSON.stringify(fingerprint)};\nexport const BACKEND_SOURCE_COMMIT: string = ${JSON.stringify(commit)};\n`);
  return fingerprint;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  console.log(process.argv.includes("--write") ? writeBackendFingerprint() : backendFingerprint());
}
