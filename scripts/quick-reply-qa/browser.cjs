const fs = require("fs"),
  assert = require("assert/strict");
async function connect(url, existingId) {
  const tab = existingId
    ? (
        await fetch(
          `${process.env.DBC_CDP_URL || "http://localhost:9224"}/json/list`,
        ).then((r) => r.json())
      ).find((t) => t.id === existingId)
    : await fetch(
        `${process.env.DBC_CDP_URL || "http://localhost:9224"}/json/new?${encodeURIComponent(url ?? "about:blank")}`,
        { method: "PUT" },
      ).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl),
    pending = new Map(),
    listeners = new Set();
  let serial = 0;
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) clearTimeout(p.timer);
      if (m.error) p?.reject(Error(m.error.message));
      else p?.resolve(m.result);
    } else for (const fn of listeners) fn(m);
  });
  const cmd = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error(
            "Browser command timed out: " +
              method +
              (method === "Runtime.evaluate"
                ? " " + params.expression?.slice(0, 240)
                : ""),
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    cmd,
    on: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    evaluate: async (expression, extra = {}) => {
      const response = await cmd("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...extra,
      });
      if (response.exceptionDetails)
        throw Error(
          response.exceptionDetails.exception?.description ||
            response.exceptionDetails.text,
        );
      return response.result?.value;
    },
    closePage: async () => {
      const result = await fetch(
        `${process.env.DBC_CDP_URL || "http://localhost:9224"}/json/close/${tab.id}`,
      );
      if (!result.ok) throw Error("Could not close private QA tab");
    },
    close: () => ws.close(),
    tabId: tab.id,
  };
}

module.exports = { connect };
