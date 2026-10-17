import assert from "node:assert/strict";
import { test } from "node:test";
import { withBackendLease, runCommand, backendRpc } from "./backend-publisher.mjs";
import { withConvexTemp } from "./convex-temp.mjs";
import { waitForBackend } from "./backend-ready.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installedToolEntry, nextBuildCommand } from "./installed-tool.mjs";

test("build tools use only installed executables, including shell-safe paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm installed ' tools-"));
  try {
    assert.throws(() => installedToolEntry("untrusted", root), /Unsupported build tool/);
    assert.throws(() => installedToolEntry("next", root), /frozen dependency installation/);
    const directory = path.join(root, "node_modules", "next");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "next", bin: { next: "cli.js" } }));
    const entry = path.join(directory, "cli.js");
    fs.writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)))");
    assert.equal(installedToolEntry("next", root), entry);
    assert.deepEqual(JSON.parse(execFileSync("/bin/sh", ["-c", nextBuildCommand(root)], { encoding: "utf8" })), ["build"]);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "next", bin: { next: "../../outside.js" } }));
    assert.throws(() => installedToolEntry("next", root), /Invalid installed next tool entry/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const commit = "a".repeat(40);
function fixture(overrides = {}) {
  const calls = [];
  const options = { commit, currentMain: () => {}, heartbeatMs: 2, pause: async () => {}, rpc: async (_kind, name, args) => { calls.push({ name, args }); return name === "acquire" ? { acquired: true } : name === "renew" ? { renewed: true } : { released: true }; }, ...overrides };
  return { calls, options };
}
test("releases after success without waiting for an idle heartbeat", async () => {
  const f = fixture({ heartbeatMs: 60_000 });
  assert.equal(await withBackendLease(async () => "complete", f.options), "complete");
  assert.deepEqual(f.calls.map(c => c.name), ["acquire", "release"]);
  assert.equal(f.calls[0].args.owner, f.calls[1].args.owner);
});
test("releases only its own lease after a command failure", async () => {
  const f = fixture();
  await assert.rejects(withBackendLease(async () => { throw Error("command failure"); }, f.options), /command failure/);
  assert.deepEqual(f.calls.map(c => c.name), ["acquire", "release"]);
});
test("a failed heartbeat aborts the running deployment and still releases its lease", async () => {
  const f = fixture({ rpc: async (_kind, name) => name === "acquire" ? { acquired: true } : name === "renew" ? { renewed: false } : { released: true } });
  let aborted = false;
  await assert.rejects(withBackendLease(signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(Error("publication stopped")); }, { once: true })), f.options), /publication stopped|ownership was lost/);
  assert.equal(aborted, true);
});
test("superseded source cannot start publishing", async () => {
  const f = fixture({ currentMain: () => { throw Error("superseded"); } }); let called = false;
  await assert.rejects(withBackendLease(async () => { called = true; }, f.options), /superseded/);
  assert.equal(called, false); assert.equal(f.calls.length, 0);
});
test("revalidates main after acquiring a contended lease", async () => {
  let checks = 0; const f = fixture({ currentMain: () => { if (++checks === 2) throw Error("superseded after acquire"); } });
  await assert.rejects(withBackendLease(async () => assert.fail("Must not publish"), f.options), /superseded after acquire/);
  assert.deepEqual(f.calls.map(c => c.name), ["acquire", "release"]);
});
test("an aborted lease stops a real local command without contacting providers", async () => {
  const abort = new AbortController();
  const command = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.env, abort.signal);
  setTimeout(() => abort.abort(), 40);
  await assert.rejects(command, /Deployment command failed/);
});
test("publication RPC retries transient errors finitely, without retrying authentication errors", async () => {
  const env = { CONVEX_DEPLOY_KEY: "local-unit-fixture-not-a-real-key" }; let calls = 0;
  const request = async () => ++calls === 1 ? new Response("temporary", { status: 503 }) : new Response(JSON.stringify({ status: "success", value: { acquired: true } }));
  assert.deepEqual(await backendRpc("mutation", "acquire", {}, { env, request, pause: async () => {} }), { acquired: true });
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(backendRpc("mutation", "acquire", {}, { env, request: async () => { calls++; return new Response("not authorized", { status: 401 }); }, pause: async () => {} }), /HTTP 401/);
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(backendRpc("query", "current", {}, { env, request: async () => { calls++; throw Error("transport down"); }, pause: async () => {} }), /three bounded attempts/);
  assert.equal(calls, 3);
});
test("compiler scratch is isolated and removed after success or failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-owned-compiler-")); let owned;
  try {
    await withConvexTemp(async env => { owned = env.CONVEX_TMPDIR; assert.equal(path.dirname(owned), root); fs.writeFileSync(path.join(owned, "scratch"), "compiler output"); }, { root, env: {} });
    assert.equal(fs.existsSync(owned), false);
    await assert.rejects(withConvexTemp(async env => { owned = env.CONVEX_TMPDIR; throw Error("compiler failed"); }, { root, env: {} }), /compiler failed/);
    assert.equal(fs.existsSync(owned), false);
    const shared = path.join(root, "shared"); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, "keep"), "existing configured data");
    await withConvexTemp(async env => assert.equal(env.CONVEX_TMPDIR, shared), { root, env: { CONVEX_TMPDIR: shared } });
    assert.equal(fs.readFileSync(path.join(shared, "keep"), "utf8"), "existing configured data");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("worker admission waits for real source identity and accepts only compatible newer inputs", async () => {
  let calls = 0, clock = 0;
  const options = { expected: "expected", commit, current: () => {}, includes: () => false, now: () => clock, pause: async () => { clock++; }, timeoutMs: 5, read: async () => ({ sourceFingerprint: ++calls < 2 ? "old" : "expected", sourceCommit: commit }) };
  assert.equal((await waitForBackend(options)).sourceFingerprint, "expected"); assert.equal(calls, 2);
  const newer = "b".repeat(40);
  assert.equal((await waitForBackend({ ...options, read: async () => ({ sourceFingerprint: "newer", sourceCommit: newer }), includes: (a, b, layer) => a === commit && b === newer && layer === "trigger" })).sourceCommit, newer);
  clock = 0;
  await assert.rejects(waitForBackend({ ...options, timeoutMs: 2, read: async () => ({ sourceFingerprint: "old", sourceCommit: "invalid" }) }), /no worker deployment started/);
  clock = 0;
  await assert.rejects(waitForBackend({ ...options, timeoutMs: 2, read: async () => ({ sourceFingerprint: "wrong", sourceCommit: commit }), includes: () => true }), /no worker deployment started/);
});
