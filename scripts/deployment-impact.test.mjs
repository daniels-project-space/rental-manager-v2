import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { classifyChanges, impactSince, assertCurrentInputs, sourceRepository } from "./deployment-impact.mjs";

test("Vercel production verifies the pinned public repository without requiring clone-local origin", () => {
  assert.equal(sourceRepository({ VERCEL_ENV: "production" }), "https://github.com/daniels-project-space/rental-manager-v2.git");
  assert.equal(sourceRepository({ VERCEL_ENV: "production", RM_SOURCE_REMOTE: "https://untrusted.example" }), "https://github.com/daniels-project-space/rental-manager-v2.git");
  assert.equal(sourceRepository({ VERCEL_ENV: "preview" }), "origin");
  assert.equal(sourceRepository({ GITHUB_ACTIONS: "true" }), "origin");
});

const manifest = () => ({ version: 1, globals: ["package.json", "pnpm-lock.yaml"], website: { files: ["src/app/page.tsx", "convex/lib/shared.ts"], uncertain: [] }, backend: { files: ["convex/query.ts", "convex/lib/shared.ts"], uncertain: [] }, trigger: { files: ["src/trigger/poll.ts", "src/lib/worker.ts", "convex/lib/shared.ts"], uncertain: [] } });
function roles(files, before = manifest(), after = manifest()) {
  const { website, backend, trigger } = classifyChanges(files, before, after);
  return [website, backend, trigger];
}

test("CI-only backup helpers do not create application deployments", () => {
  assert.deepEqual(roles([".github/scripts/backup-to-r2.mjs", ".github/scripts/backup-checksum.mjs"]), [false, false, false]);
});
test("runtime consumers override metadata-directory exclusions, including deleted dependencies", () => {
  const website = manifest(); website.website.files.push(".github/scripts/shared.mjs");
  assert.deepEqual(roles([".github/scripts/shared.mjs"], website, website), [true, false, false]);
  const worker = manifest(); worker.trigger.files.push(".github/scripts/shared.mjs");
  assert.deepEqual(roles([".github/scripts/shared.mjs"], worker, manifest()), [false, false, true]);
});
test("release-control changes follow their actual consumers without publishing unchanged workers", () => {
  const m = manifest(); m.website.files.push("scripts/deployment-impact.mjs"); m.backend.files.push("scripts/deployment-impact.mjs");
  assert.deepEqual(roles(["scripts/deployment-impact.mjs"], m, m), [true, true, false]);
  assert.deepEqual(roles(["package.json"], m, m), [true, true, true]);
});
for (const [name, files, expected] of [
  ["backend implementation", ["convex/query.ts"], [false, true, false]],
  ["new backend module", ["convex/newQuery.ts"], [false, true, false]],
  ["worker entry", ["src/trigger/poll.ts"], [false, false, true]],
  ["transitive worker helper", ["src/lib/worker.ts"], [true, false, true]],
  ["shared runtime module", ["convex/lib/shared.ts"], [true, true, true]],
  ["website runtime", ["src/app/page.tsx"], [true, false, false]],
  ["unrecognized runtime input", ["custom-runtime.json"], [true, false, false]],
  ["shared dependencies", ["pnpm-lock.yaml"], [true, true, true]],
  ["unit test only", ["convex/query.test.ts"], [false, false, false]],
  ["documentation only", ["docs/design.md"], [false, false, false]],
  ["no changes", [], [false, false, false]],
]) test(name, () => assert.deepEqual(roles(files), expected));

test("missing or unsupported manifest builds every layer", () => {
  assert.deepEqual(roles(["convex/query.ts"], undefined, null), [true, true, true]);
  assert.deepEqual(roles(["docs/readme.md"], { ...manifest(), version: 2 }), [true, true, true]);
});
test("removed dependencies still trigger their old consumers", () => {
  const after = manifest(); after.website.files = [];
  assert.deepEqual(roles(["convex/lib/shared.ts"], manifest(), after), [true, true, true]);
});
test("an unresolved website import keeps website builds conservative", () => {
  const after = manifest(); after.website.uncertain.push("dynamic import");
  assert.deepEqual(roles(["convex/query.ts"], manifest(), after), [true, true, false]);
});
test("a changed website boundary builds, while backend-only manifest growth does not", () => {
  const backend = manifest(); backend.backend.files.push("convex/newQuery.ts");
  assert.deepEqual(roles(["deployment-inputs.json"], manifest(), backend), [false, true, false]);
  const website = manifest(); website.website.files.push("convex/lib/newHelper.ts");
  assert.deepEqual(roles(["deployment-inputs.json"], manifest(), website), [true, false, false]);
});
test("real Git history, missing history, force override and pre-install CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-deployment-impact-"));
  function git(...args) { return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  try {
    git("init", "-q"); git("config", "user.email", "local@example.invalid"); git("config", "user.name", "Local contract");
    fs.mkdirSync(path.join(root, "convex"));
    fs.writeFileSync(path.join(root, "deployment-inputs.json"), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(root, "convex/query.ts"), "export const value = 1;\n");
    git("add", "."); git("commit", "-qm", "Initial inputs"); const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(root, "convex/query.ts"), "export const value = 2;\n");
    git("add", "."); git("commit", "-qm", "Backend implementation");
    assert.equal(impactSince(base, root).website, false);
    assert.equal(impactSince(base, root).backend, true);
    assert.equal(impactSince("f".repeat(40), root).website, true);
    const script = path.resolve("scripts/deployment-impact.mjs");
    const run = env => spawnSync(process.execPath, [script, "--vercel-ignore"], { cwd: root, env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: base, ...env }, encoding: "utf8" });
    assert.equal(run({ RM_SPLIT_DEPLOYMENTS: "enabled", VERCEL_FORCE_BUILD: "0" }).status, 0);
    assert.equal(run({ RM_SPLIT_DEPLOYMENTS: "disabled", VERCEL_FORCE_BUILD: "0" }).status, 1);
    assert.equal(run({ RM_SPLIT_DEPLOYMENTS: "enabled", VERCEL_FORCE_BUILD: "1" }).status, 1);
    assert.equal(run({ RM_SPLIT_DEPLOYMENTS: "enabled", VERCEL_GIT_PREVIOUS_SHA: "" }).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("queued publishers tolerate unrelated newer commits and reject newer layer inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-current-inputs-"));
  const work = path.join(root, "work"), remote = path.join(root, "origin.git"); fs.mkdirSync(work);
  function git(...args) { return execFileSync("git", args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "local@example.invalid"); git("config", "user.name", "Local contract");
    fs.mkdirSync(path.join(work, "convex")); fs.writeFileSync(path.join(work, "convex/query.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(work, "deployment-inputs.json"), JSON.stringify(manifest()));
    git("add", "."); git("commit", "-qm", "Inputs"); const base = git("rev-parse", "HEAD");
    git("clone", "--bare", work, remote); git("remote", "add", "origin", remote);
    assertCurrentInputs(base, "backend", work);
    fs.writeFileSync(path.join(work, "README.md"), "Documentation\n"); git("add", "."); git("commit", "-qm", "Docs"); git("push", "origin", "main");
    assertCurrentInputs(base, "backend", work); assertCurrentInputs(base, "trigger", work);
    fs.writeFileSync(path.join(work, "convex/query.ts"), "export const value = 2;\n"); git("add", "."); git("commit", "-qm", "Backend"); git("push", "origin", "main");
    assert.throws(() => assertCurrentInputs(base, "backend", work), /inputs are superseded/);
    assertCurrentInputs(base, "website", work);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
