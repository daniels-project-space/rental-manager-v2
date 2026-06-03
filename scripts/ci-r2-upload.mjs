#!/usr/bin/env node
/**
 * ci-r2-upload.mjs
 * Upload a local file to Cloudflare R2 and verify the upload via HeadObject.
 *
 * Usage: node scripts/ci-r2-upload.mjs <localPath> <r2Key>
 *
 * Required env vars (never hardcoded):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT
 */

import { readFileSync, statSync } from "node:fs";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = "rental-manager-v2";

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: missing required env var ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const [, , localPath, r2Key] = process.argv;

  if (!localPath || !r2Key) {
    console.error("Usage: node scripts/ci-r2-upload.mjs <localPath> <r2Key>");
    process.exit(1);
  }

  const accountId = requiredEnv("R2_ACCOUNT_ID");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
  const endpoint = requiredEnv("R2_ENDPOINT");

  // Stat local file before uploading
  let localStat;
  try {
    localStat = statSync(localPath);
  } catch (err) {
    console.error(`ERROR: cannot stat local file ${localPath}: ${err.message}`);
    process.exit(1);
  }
  const localBytes = localStat.size;

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  // Read file
  let fileBody;
  try {
    fileBody = readFileSync(localPath);
  } catch (err) {
    console.error(`ERROR: cannot read local file ${localPath}: ${err.message}`);
    process.exit(1);
  }

  // Upload
  console.log(`Uploading ${localPath} (${localBytes} bytes) → s3://${BUCKET}/${r2Key}`);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: r2Key,
        Body: fileBody,
        ContentLength: localBytes,
      })
    );
  } catch (err) {
    console.error(`ERROR: PutObject failed: ${err.message}`);
    process.exit(1);
  }

  // Verify via HeadObject
  let head;
  try {
    head = await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: r2Key })
    );
  } catch (err) {
    console.error(`ERROR: HeadObject verification failed: ${err.message}`);
    process.exit(1);
  }

  const remoteBytes = head.ContentLength ?? null;
  if (remoteBytes === null) {
    console.error("ERROR: HeadObject returned no ContentLength — cannot verify.");
    process.exit(1);
  }
  if (remoteBytes !== localBytes) {
    console.error(
      `ERROR: size mismatch — local ${localBytes} bytes, remote ${remoteBytes} bytes`
    );
    process.exit(1);
  }

  console.log(`OK: verified ${remoteBytes} bytes at s3://${BUCKET}/${r2Key}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
