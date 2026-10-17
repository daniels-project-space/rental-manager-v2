import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const manifestName = "deployment-inputs.json";
const nonRuntime = file => /(?:^|\/)__tests__\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /^(?:docs|graphify-out|\.serena|\.agents|\.codex|coverage|\.github)\//.test(file) || /(?:^|\/)(?:README|AGENTS)\.md$/.test(file);
const all = reason => ({ website: true, backend: true, trigger: true, reason });

/** Vercel's source snapshot need not retain a usable origin remote. This
 * project is public: pin its trusted repository for production freshness
 * checks instead of relying on clone-local remote configuration. */
export function sourceRepository(env = process.env) {
  return env.VERCEL_ENV === "production" ? "https://github.com/daniels-project-space/rental-manager-v2.git" : "origin";
}

/** Node built-ins only: this also runs in Vercel's pre-install ignore step. */
export function classifyChanges(files, before, after) {
  if (!before || !after || before.version !== 1 || after.version !== 1) return all("missing_or_unknown_dependency_manifest");
  const result = { website: false, backend: false, trigger: false, reason: "classified_dependencies", changedFiles: files };
  const manifests = [before, after];
  for (const file of files) {
    if (nonRuntime(file)) continue;
    if (manifests.some(manifest => manifest.globals.includes(file))) return all("shared_build_configuration_changed");
    for (const layer of ["website", "backend", "trigger"]) {
      if (manifests.some(manifest => manifest[layer].uncertain.length || manifest[layer].files.includes(file))) result[layer] = true;
    }
    if (file.startsWith("convex/") || file === "convex.json") result.backend = true;
    else if (file.startsWith("src/trigger/") || file === "trigger.config.ts") result.trigger = true;
    else if (file === manifestName) {
      // Adding an unused backend module should not rebuild the UI. A changed
      // website boundary does require a build, including removed dependencies.
      for (const layer of ["website", "backend", "trigger"]) if (JSON.stringify(before[layer]) !== JSON.stringify(after[layer])) result[layer] = true;
    } else if (!file.startsWith("src/hygglo-core/")) result.website = true;
    // A core module absent from both graphs is not a website/worker input.
  }
  return result;
}

export function impactSince(base, root = process.cwd()) {
  if (!base || !/^[a-f0-9]{40}$/.test(base)) return all("missing_or_invalid_base_commit");
  function git(args) { return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString(); }
  try {
    git(["merge-base", "--is-ancestor", base, "HEAD"]);
    const before = JSON.parse(git(["show", `${base}:${manifestName}`]));
    const after = JSON.parse(fs.readFileSync(path.join(root, manifestName), "utf8"));
    // --no-renames reports both the deletion and addition; both old and new
    // dependency sets matter when a shared module moves or disappears.
    const files = git(["diff", "--no-renames", "--name-only", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    return classifyChanges(files, before, after);
  } catch { return all("unavailable_history_or_dependency_manifest"); }
}

/** An older queued publisher may still finish when newer commits touch only
 * another layer or docs. It must never replace newer inputs for its own layer.
 * Missing history/manifests are not evidence that publication is safe. */
export function assertCurrentInputs(commit, layer, root = process.cwd(), env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !["website", "backend", "trigger"].includes(layer)) throw Error("Invalid production source identity");
  function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }); }
  const repository = sourceRepository(env);
  let latest, result, stage = "read_main_ref";
  try {
    latest = git(["ls-remote", repository, "refs/heads/main"]).split(/\s/)[0];
    if (!/^[a-f0-9]{40}$/.test(latest)) throw Error("Main ref unavailable");
    if (latest === commit) return;
    stage = "fetch_main";
    git(["fetch", "--no-tags", repository, latest]);
    stage = "verify_ancestry";
    git(["merge-base", "--is-ancestor", commit, latest]);
    stage = "compare_inputs";
    const before = JSON.parse(git(["show", `${commit}:${manifestName}`]));
    const after = JSON.parse(git(["show", `${latest}:${manifestName}`]));
    const files = git(["diff", "--no-renames", "--name-only", "-z", commit, latest]).split("\0").filter(Boolean);
    result = classifyChanges(files, before, after);
  } catch { throw Error(`Cannot verify production source inputs against current main (${stage})`); }
  if (result[layer]) throw Error(`Production ${layer} inputs are superseded; use the latest qualified Git release`);
}

export function publishedInputsInclude(commit, publishedCommit, layer, root = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(publishedCommit) || !["website", "backend", "trigger"].includes(layer)) return false;
  function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 }); }
  try {
    if (commit === publishedCommit) return true;
    git(["fetch", "--no-tags", "origin", publishedCommit]);
    git(["merge-base", "--is-ancestor", commit, publishedCommit]);
    const before = JSON.parse(git(["show", `${commit}:${manifestName}`]));
    const after = JSON.parse(git(["show", `${publishedCommit}:${manifestName}`]));
    const files = git(["diff", "--no-renames", "--name-only", "-z", commit, publishedCommit]).split("\0").filter(Boolean);
    return !classifyChanges(files, before, after)[layer];
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const base = process.argv.slice(2).find(value => !value.startsWith("--")) || process.env.VERCEL_GIT_PREVIOUS_SHA;
  const result = impactSince(base);
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, ["website", "backend", "trigger"].map(key => `${key}=${result[key]}\n`).join(""));
  if (process.argv.includes("--vercel-ignore")) {
    // Until the independent backend publisher is qualified and enabled, retain
    // existing backend publication through the production Vercel build.
    const split = process.env.RM_SPLIT_DEPLOYMENTS === "enabled";
    process.exit(process.env.VERCEL_FORCE_BUILD === "1" || result.website || result.backend && !split ? 1 : 0);
  }
}
