import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("reply inbox Convex runtime declaration", () => {
  it("keeps the Node runtime directive in the module directive prologue", () => {
    const path = resolve(process.cwd(), "convex/replyInbox_actions.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const first = source.statements[0];
    expect(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use node").toBe(true);
  });
});
