import { createHash } from "node:crypto";

export function backupChecksumClientOptions() {
  // The uploader supplies Content-MD5 explicitly. R2 rejects a second,
  // automatically added CRC32 checksum; retain the enforced MD5 validation.
  return { requestChecksumCalculation: "WHEN_REQUIRED" };
}

export function backupChecksum(bytes) {
  const md5 = createHash("md5").update(bytes).digest();
  return { bytes: bytes.byteLength, md5: md5.toString("hex"), contentMD5: md5.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function verifyBackupHead(head, expected) {
  if (head.ContentLength !== expected.bytes) throw Error("Backup object size does not match its source");
  if (head.Metadata?.sha256 !== expected.sha256) throw Error("Backup object source hash metadata does not match");
}
