import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBackupStorage, uploadBackup } from "./backup-to-r2.mjs";
import { backupChecksum, verifyBackupHead, backupChecksumClientOptions } from "./backup-checksum.mjs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { classifyChanges } from "../../scripts/deployment-impact.mjs";

const account = "b".repeat(32);
const endpoint = `https://${account}.r2.cloudflarestorage.com`;
const deployKey = "local-fixture-deployment-key";
function fixture(changes = {}, extra = []) {
  const values = { R2_ACCOUNT_ID: account, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: "fixture-access", R2_SECRET_ACCESS_KEY: "fixture-secret", R2_BUCKET: "rental-manager-v2", ...changes };
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const value = url.startsWith("https://hearty-oyster-600.") ? { name: "VAULT_ACCESS_TOKEN", value: "fixture-vault-token" } : [...Object.entries(values).map(([keyName, value]) => ({ keyName, value })), ...extra];
    return new Response(JSON.stringify({ status: "success", value }));
  };
  return { calls, options: { deployKey, request, wait: async () => {} } };
}

test("resolves current project credentials from its own backend and vault service", async () => {
  const f = fixture();
  const result = await loadBackupStorage(f.options);
  assert.deepEqual(result, { R2_ACCOUNT_ID: account, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: "fixture-access", R2_SECRET_ACCESS_KEY: "fixture-secret" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, "https://hearty-oyster-600.convex.cloud/api/query");
  assert.equal(f.calls[0].body.path, "_system/cli/queryEnvironmentVariables:get");
  assert.deepEqual(f.calls[0].body.args, [{ name: "VAULT_ACCESS_TOKEN" }]);
  assert.equal(f.calls[0].options.headers.Authorization, `Convex ${deployKey}`);
  assert.equal(f.calls[1].url, "https://fantastic-roadrunner-485.convex.cloud/api/query");
  assert.equal(f.calls[1].options.headers.Authorization, undefined);
  assert.deepEqual(f.calls[1].body.args, { service: "cloudflare", vaultToken: "fixture-vault-token" });
  assert.ok(f.calls.every(call => call.options.redirect === "error" && call.options.signal instanceof AbortSignal));
});

test("rejects missing, cross-project, ambiguous or malformed storage credentials", async () => {
  await assert.rejects(loadBackupStorage({ ...fixture().options, deployKey: "" }), /deployment credential/);
  for (const changes of [
    { R2_BUCKET: "another-project" },
    { R2_ACCOUNT_ID: "wrong-account" },
    { R2_ENDPOINT: "https://untrusted.example" },
    { R2_ENDPOINT: `${endpoint}/unexpected-path` },
    { R2_SECRET_ACCESS_KEY: "" },
    { R2_ACCESS_KEY_ID: "credential\nwith-newline" },
  ]) await assert.rejects(loadBackupStorage(fixture(changes).options), /different application|Invalid|unavailable/);
  await assert.rejects(loadBackupStorage(fixture({}, [{ keyName: "R2_SECRET_ACCESS_KEY", value: "duplicate" }]).options), /Ambiguous/);
});

test("retries only bounded transient credential failures and never leaks response details", async () => {
  const f = fixture(); let calls = 0;
  const result = await loadBackupStorage({ ...f.options, request: async (...args) => ++calls === 1 ? new Response("temporary", { status: 503 }) : f.options.request(...args) });
  assert.equal(result.R2_ENDPOINT, endpoint); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(loadBackupStorage({ ...f.options, request: async () => { calls++; return new Response("private response must not leak", { status: 401 }); } }), error => error.message === "Backup credential query failed with HTTP 401");
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(loadBackupStorage({ ...f.options, request: async () => { calls++; throw Error("private transport details"); } }), error => error.message === "Backup credential transport unavailable after three bounded attempts");
  assert.equal(calls, 3);
});

test("hands current credentials only to the existing direct uploader without storing secret files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-backup-wrapper-"));
  const snapshot = path.join(root, "snapshot with spaces.zip"); fs.writeFileSync(snapshot, "local snapshot fixture");
  const key = "backups/rmv2/20261017/convex-hearty-oyster-600.zip";
  let called = false;
  try {
    await uploadBackup(snapshot, key, {
      env: { CONVEX_DEPLOY_KEY: deployKey, VAULT_ACCESS_TOKEN: "do-not-forward", PATH: "/usr/bin" },
      load: async args => { assert.equal(args.deployKey, deployKey); return { R2_ACCOUNT_ID: account, R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: "current-access", R2_SECRET_ACCESS_KEY: "current-secret" }; },
      run: async (command, args, env) => {
        called = true; assert.equal(command, process.execPath);
        assert.equal(path.basename(args[0]), "ci-r2-upload.mjs"); assert.deepEqual(args.slice(1), [snapshot, key]);
        assert.equal(env.R2_ACCESS_KEY_ID, "current-access"); assert.equal(env.CONVEX_DEPLOY_KEY, undefined); assert.equal(env.VAULT_ACCESS_TOKEN, undefined);
      },
    });
    assert.equal(called, true); assert.deepEqual(fs.readdirSync(root), [path.basename(snapshot)]);
    const load = async () => assert.fail("Invalid backup input must not request credentials");
    await assert.rejects(uploadBackup(snapshot, "another-project/key", { load }), /existing Rental Manager backup key/);
    await assert.rejects(uploadBackup(path.join(root, "missing.zip"), key, { load }), /snapshot is unavailable/);
    fs.writeFileSync(snapshot, ""); await assert.rejects(uploadBackup(snapshot, key, { load }), /empty or invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("checks complete source bytes and rejects size or hash metadata drift", () => {
  const expected = backupChecksum(Buffer.from("abc"));
  assert.equal(expected.bytes, 3);
  assert.equal(expected.md5, "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(expected.contentMD5, "kAFQmDzST7DWlj99KOF/cg==");
  assert.equal(expected.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.doesNotThrow(() => verifyBackupHead({ ContentLength: 3, Metadata: { sha256: expected.sha256 } }, expected));
  assert.throws(() => verifyBackupHead({ ContentLength: 4, Metadata: { sha256: expected.sha256 } }, expected), /size/);
  assert.throws(() => verifyBackupHead({ ContentLength: 3, Metadata: { sha256: "wrong" } }, expected), /hash metadata/);
});

test("the installed SDK sends only the explicit validated MD5 checksum to R2", async () => {
  const bytes = Buffer.from("abc"), checksum = backupChecksum(bytes);
  let headers;
  const client = new S3Client({
    region: "auto", endpoint, credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
    ...backupChecksumClientOptions(),
    requestHandler: { handle: async request => { headers = request.headers; return { response: { statusCode: 200, headers: {}, body: new Uint8Array() } }; } },
  });
  try {
    await client.send(new PutObjectCommand({ Bucket: "rental-manager-v2", Key: "backups/rmv2/20261017/convex-hearty-oyster-600.zip", Body: bytes, ContentLength: bytes.length, ContentMD5: checksum.contentMD5, Metadata: { sha256: checksum.sha256 } }));
    assert.equal(headers["content-md5"], checksum.contentMD5);
    assert.equal(headers["x-amz-meta-sha256"], checksum.sha256);
    assert.deepEqual(Object.keys(headers).filter(key => key.startsWith("x-amz-checksum-")), []);
  } finally { client.destroy(); }
});

test("the published project manifest preserves the actual runtime consumers of CI helpers", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../../deployment-inputs.json", import.meta.url), "utf8"));
  for (const file of [".github/scripts/backup-to-r2.mjs", ".github/scripts/ci-r2-upload.mjs", ".github/scripts/backup-checksum.mjs"]) {
    const actual = classifyChanges([file], manifest, manifest);
    for (const layer of ["website", "backend", "trigger"]) {
      const expected = manifest.globals.includes(file) || manifest[layer].files.includes(file);
      assert.equal(actual[layer], expected, `${file}: preserve recorded ${layer} consumers`);
    }
  }
});
