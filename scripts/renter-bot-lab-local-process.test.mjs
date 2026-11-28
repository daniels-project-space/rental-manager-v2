import { expect, it } from "vitest";
import { once } from "node:events";
import { spawnRenterBotLabLocalChild } from "./renter-bot-lab-local-process.mjs";

it("keeps local Lab children alive without depending on a terminal output pipe", async () => {
  const child = spawnRenterBotLabLocalChild(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(512 * 1024)); process.stderr.write('y'.repeat(512 * 1024));",
  ]);
  const [code, signal] = await once(child, "close");
  expect(code).toBe(0);
  expect(signal).toBeNull();
});
