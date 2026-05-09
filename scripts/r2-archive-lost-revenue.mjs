import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SECRETS = JSON.parse(execSync(`curl -sS https://fantastic-roadrunner-485.convex.cloud/api/query -H 'Content-Type: application/json' -d '{"path":"secrets:listByService","args":{"service":"cloudflare"}}'`).toString());
const get = (k) => SECRETS.value.find((s) => s.keyName === k).value;

const client = new S3Client({
  region: 'auto',
  endpoint: get('R2_ENDPOINT'),
  credentials: {
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
  },
});

const Bucket = 'rental-manager-v2';
const Key = 'archive/lost_revenue_record/2026-05-09.jsonl.gz';
const Body = readFileSync('/tmp/lost_revenue_archive.jsonl.gz');

console.log(`Uploading ${Body.length} bytes to s3://${Bucket}/${Key} ...`);
const put = await client.send(new PutObjectCommand({
  Bucket, Key, Body,
  ContentType: 'application/gzip',
  ContentEncoding: 'gzip',
  Metadata: {
    source: 'v1-postgres-lost_revenue_record',
    rows: '4795',
    captured_at: new Date().toISOString(),
    phase: 'p2_a_data_import',
  },
}));
console.log('put OK ETag:', put.ETag);

const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
console.log('HEAD:', JSON.stringify({
  ContentLength: head.ContentLength,
  ETag: head.ETag,
  LastModified: head.LastModified,
  Metadata: head.Metadata,
}, null, 2));
