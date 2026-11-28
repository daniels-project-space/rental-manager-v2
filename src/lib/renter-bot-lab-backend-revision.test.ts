import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renterBotLabBackendSourceFingerprint } from "./renter-bot-lab-backend-revision.mjs";

const roots: string[] = [];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "renter-bot-revision-"));
  roots.push(root);
  mkdirSync(join(root, "convex", "lib"), { recursive: true });
  writeFileSync(join(root, "convex", "replyInbox_actions.ts"), "export const runtime = true;\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Renter Bot Lab backend source fingerprint", () => {
  it("ignores tests and type declarations while detecting runtime source changes", () => {
    const root = fixtureRoot();
    const initial = renterBotLabBackendSourceFingerprint(root);
    writeFileSync(join(root, "convex", "replyInbox_actions.test.ts"), "it('test only', () => {});\n");
    writeFileSync(join(root, "convex", "_generated.d.ts"), "export type GeneratedOnly = string;\n");
    expect(renterBotLabBackendSourceFingerprint(root)).toBe(initial);

    writeFileSync(join(root, "convex", "replyInbox_actions.ts"), "export const runtime = false;\n");
    expect(renterBotLabBackendSourceFingerprint(root)).not.toBe(initial);
  });
});
