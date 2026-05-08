// Thin S3-compatible wrapper for Cloudflare R2.
// Pattern adapted from `daniels-project-space/platform-storage` template — each
// app vendors its own copy instead of installing the shared package, keeping
// the app self-contained.
//
// Bucket: `rental-manager-v2`
// Prefixes used by the app (created lazily on first put):
//   photos/        - Hygglo listing photos (public via signed URL)
//   attachments/   - misc uploads from the dashboard
//   db-snapshots/  - Convex export dumps (Phase 1+)
//
// Required env (loaded from project-hub vault `cloudflare` + `r2-rental-manager-v2`):
//   R2_ACCOUNT_ID
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET           (= "rental-manager-v2")
//
// SAFETY: This module is server-only. Never import from a "use client" file.

import "server-only";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandInput,
  type GetObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`storage: missing env var ${key}`);
  }
  return v;
}

let _client: S3Client | null = null;

export function r2Client(): S3Client {
  if (_client) return _client;
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _client;
}

export function bucket(): string {
  return requireEnv("R2_BUCKET");
}

export type PutOpts = {
  key: string;
  body: PutObjectCommandInput["Body"];
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
};

export async function putObject(opts: PutOpts): Promise<{ key: string }> {
  const cmd = new PutObjectCommand({
    Bucket: bucket(),
    Key: opts.key,
    Body: opts.body,
    ContentType: opts.contentType,
    CacheControl: opts.cacheControl,
    Metadata: opts.metadata,
  });
  await r2Client().send(cmd);
  return { key: opts.key };
}

export async function getObject(key: string) {
  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key });
  return r2Client().send(cmd);
}

export async function deleteObject(key: string): Promise<void> {
  const cmd = new DeleteObjectCommand({ Bucket: bucket(), Key: key });
  await r2Client().send(cmd);
}

export type SignedUrlOpts = {
  key: string;
  expiresIn?: number; // seconds, default 3600
  operation?: "get" | "put";
  contentType?: string; // for put
};

export async function signedUrl(opts: SignedUrlOpts): Promise<string> {
  const expiresIn = opts.expiresIn ?? 3600;
  if ((opts.operation ?? "get") === "get") {
    const input: GetObjectCommandInput = { Bucket: bucket(), Key: opts.key };
    return getSignedUrl(r2Client(), new GetObjectCommand(input), { expiresIn });
  }
  const input: PutObjectCommandInput = {
    Bucket: bucket(),
    Key: opts.key,
    ContentType: opts.contentType,
  };
  return getSignedUrl(r2Client(), new PutObjectCommand(input), { expiresIn });
}
