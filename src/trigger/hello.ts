// Smoke-test task. Confirms Trigger.dev wiring works end-to-end.
// Real tasks (Hygglo polling, photo backfill, etc.) land in Phase 4.
//
// Usage:
//   import { tasks } from "@trigger.dev/sdk/v3";
//   await tasks.trigger("hello", { note: "ping" });

import { task } from "@trigger.dev/sdk/v3";

export const helloTask = task({
  id: "hello",
  maxDuration: 30,
  run: async (payload: { note?: string } = {}, { ctx }) => {
    return {
      ok: true,
      ts: Date.now(),
      note: payload.note ?? null,
      runId: ctx.run.id,
      project: ctx.project.ref,
    };
  },
});
